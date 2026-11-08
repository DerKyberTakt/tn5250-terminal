import * as vscode from 'vscode';
import { importCodeForIbmi, type PortChoice } from '../shared/c4iImport';
import { importHod } from '../shared/hodImport';
import { isSaved, mergeImported } from '../shared/sessionImport';
import type { SessionOverrides } from '../shared/settings';
import { acsEmulatorDir } from './kmpCommand';
import { readDefaults, readSessions, resolvedSessions, writeSessions } from './settingsStore';

/**
 * TN5250: Import Connections. Reads ACS session profiles (.hod) or the Code for IBM i
 * connection list, lets the user select the connections to add and appends them to the
 * saved sessions. A connection already saved is replaced in place, keeping what only the
 * emulator has (a trusted certificate, for one), so importing again never duplicates.
 */

interface Found {
  sessions: Array<{ session: SessionOverrides; notes: string[] }>;
  skipped: Array<{ name: string; reason: string }>;
}

export interface ImportOutcome {
  message: string;
  /** Connections added or replaced. */
  imported: number;
  /** Index of the first imported connection in the saved list. */
  firstIndex: number;
}

type Source = 'acs' | 'files' | 'c4i';

/** Decodes a .hod file: UTF-8, as ACS writes it, or Latin-1 for older files that are not valid UTF-8. */
function decode(bytes: Uint8Array): string {
  const utf8 = Buffer.from(bytes).toString('utf8');
  const replacement = String.fromCharCode(0xfffd); // what an invalid UTF-8 sequence decodes to
  return utf8.includes(replacement) ? Buffer.from(bytes).toString('latin1') : utf8;
}

async function listHodFiles(dir: vscode.Uri): Promise<vscode.Uri[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries
      .filter(([name, type]) => type === vscode.FileType.File && /\.hod$/i.test(name))
      .map(([name]) => vscode.Uri.joinPath(dir, name))
      .sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    return [];
  }
}

async function readHodFiles(files: vscode.Uri[]): Promise<Found> {
  const found: Found = { sessions: [], skipped: [] };
  for (const file of files) {
    const name = file.path.split('/').pop() ?? file.path;
    let text: string;
    try {
      text = decode(await vscode.workspace.fs.readFile(file));
    } catch {
      found.skipped.push({ name, reason: 'could not be read' });
      continue;
    }
    const r = importHod(text, name);
    if (r.ok) found.sessions.push({ session: r.session, notes: r.notes });
    else found.skipped.push({ name: r.name, reason: r.reason });
  }
  return found;
}

function codeForIbmiConnections(): unknown {
  return vscode.workspace.getConfiguration('code-for-ibmi').get<unknown>('connections');
}

/** The 5250 port and TLS of each host already saved (the first connection to it wins). */
function savedPorts(): (host: string) => PortChoice | undefined {
  const byHost = new Map<string, PortChoice>();
  for (const s of resolvedSessions()) {
    const key = s.host.trim().toLowerCase();
    if (key && !byHost.has(key)) byHost.set(key, { port: s.port, tls: s.tls });
  }
  return (host) => byHost.get(host.trim().toLowerCase());
}

async function readCodeForIbmi(): Promise<Found | undefined> {
  const found: Found = { sessions: [], skipped: [] };
  const unknown: SessionOverrides[] = [];
  for (const r of importCodeForIbmi(codeForIbmiConnections(), savedPorts())) {
    if (!r.ok) {
      found.skipped.push({ name: r.name, reason: r.reason });
      continue;
    }
    found.sessions.push({ session: r.session, notes: r.portKnown ? ['port from the saved connection to this host'] : [] });
    if (!r.portKnown) unknown.push(r.session);
  }
  if (unknown.length) {
    // Code for IBM i keeps only the SSH port: ask once for the hosts no saved connection knows.
    const choices = [
      { label: 'Telnet', description: 'port 23', port: 23, tls: false },
      { label: 'TLS', description: 'port 992', port: 992, tls: true },
    ];
    if (readDefaults().tls) choices.reverse();
    const names = unknown.map((s) => s.name).join(', ');
    const pick = await vscode.window.showQuickPick(choices, {
      title: 'TN5250: Import from Code for IBM i',
      placeHolder: `5250 port for ${names} (Code for IBM i keeps only the SSH port)`,
      ignoreFocusOut: true,
    });
    if (!pick) return undefined;
    for (const s of unknown) {
      s.port = pick.port;
      s.tls = pick.tls;
    }
  }
  return found;
}

function detail(session: SessionOverrides, notes: string[]): string | undefined {
  const parts = [
    session.screenSize,
    session.codePage !== undefined ? `CCSID ${session.codePage}` : undefined,
    session.deviceName ? `device ${session.deviceName}` : undefined,
    session.signonUser ? `user ${session.signonUser}` : undefined,
    ...notes,
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join(', ') : undefined;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function importConnectionsInteractive(): Promise<ImportOutcome | undefined> {
  // Only 5250 display sessions are ever offered, so the counts and messages speak of those
  // alone; printer, 3270 and VT profiles are left out without a word.
  const acsDir = acsEmulatorDir();
  const acsFound = acsDir ? await readHodFiles(await listHodFiles(acsDir)) : undefined;
  const c4i = codeForIbmiConnections();
  const c4iCount = Array.isArray(c4i) ? c4i.length : 0;

  const sources: Array<vscode.QuickPickItem & { source: Source }> = [];
  if (acsDir && acsFound?.sessions.length) {
    sources.push({ label: '$(file) ACS session profiles', description: `${plural(acsFound.sessions.length, 'session')} in ${acsDir.fsPath}`, source: 'acs' });
  }
  if (c4iCount) sources.push({ label: '$(remote) Code for IBM i connections', description: `${c4iCount} found`, source: 'c4i' });
  sources.push({ label: '$(folder-opened) Choose .hod files...', description: 'ACS session profiles saved in another folder', source: 'files' });

  const source = await vscode.window.showQuickPick(sources, { title: 'TN5250: Import Connections', placeHolder: 'Import from', ignoreFocusOut: true });
  if (!source) return undefined;

  let found: Found | undefined;
  if (source.source === 'acs') {
    found = acsFound;
  } else if (source.source === 'c4i') {
    found = await readCodeForIbmi();
  } else {
    const picked = await vscode.window.showOpenDialog({
      title: 'Import ACS session profiles',
      canSelectMany: true,
      defaultUri: acsDir,
      filters: { 'ACS session profile': ['hod'], 'All files': ['*'] },
    });
    if (picked?.length) found = await readHodFiles(picked);
  }
  if (!found) return undefined;

  // A file that could not be read is an error, not a filter: it is the one skip worth telling.
  const unreadable = found.skipped.filter((s) => s.reason === 'could not be read').length;
  const unreadableNote = unreadable ? ` ${plural(unreadable, 'file')} could not be read.` : '';
  if (!found.sessions.length) {
    return { message: `TN5250: no 5250 display sessions found.${unreadableNote}`, imported: 0, firstIndex: -1 };
  }

  // Every display session is offered and selected; one already saved replaces the saved
  // entry (keeping what only the emulator has, such as a trusted certificate).
  const saved = readSessions();
  const items = found.sessions.map(({ session, notes }) => {
    const where = `${session.host}${session.port ? `:${session.port}` : ''}${session.tls ? '  TLS' : ''}`;
    return {
      label: session.name || session.host,
      description: isSaved(saved, session) ? `${where}  (replaces the saved one)` : where,
      detail: detail(session, notes),
      picked: true,
      session,
    };
  });
  const chosen = await vscode.window.showQuickPick(items, {
    title: 'TN5250: Import Connections',
    placeHolder: 'Select the connections to import',
    canPickMany: true,
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  if (!chosen?.length) return undefined;

  const merged = mergeImported(readSessions(), chosen.map((c) => c.session));
  await writeSessions(merged.sessions);
  const n = merged.touched.length;
  const replaced = merged.replaced.length ? ` (${merged.replaced.length} replaced saved ones)` : '';
  return {
    message: `TN5250: ${plural(n, 'connection')} imported${replaced}.${unreadableNote}`,
    imported: n,
    firstIndex: merged.touched[0] ?? -1,
  };
}
