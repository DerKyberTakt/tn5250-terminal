/**
 * Talks to a running `tn5250-tui mcp` server (the console terminal's MCP server for AI
 * agents): finds its token file, lists its sessions. Pure Node (no vscode import) so it
 * can be tested; the Agent Sessions view sits on top of it.
 *
 * The server writes `<sites dir>/agent/<pid>.json` ({ pid, addr, token, started, label })
 * and speaks JSON lines on 127.0.0.1:<port>: a hello with the token, then `list`
 * requests answered with `sessions`.
 */
import { readdirSync, readFileSync, statSync, unlinkSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { Socket, createConnection } from 'node:net';

export interface AgentToken {
  pid: number;
  addr: string;
  token: string;
  started: string;
  label?: string;
  path: string;
}

export interface AgentSession {
  session: string;
  host: string;
  device?: string;
  connected: boolean;
  since?: string;
  seq: number;
  inhibited?: string;
}

interface WireMsg {
  t: string;
  token?: string;
  session?: string;
  sessions?: AgentSession[];
  text?: string;
}

/** The token directory: beside the console terminal's sites file. */
export function tokenDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const cfg = env.TN5250_TUI_CONFIG;
  if (cfg) return join(cfg, '..', 'agent');
  if (platform === 'win32') {
    const base = env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(base, 'tn5250-tui', 'agent');
  }
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'tn5250-tui', 'agent');
}

/** The console terminal's sites file (sites.json), beside the token directory. */
export function sitesPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.TN5250_TUI_CONFIG) return env.TN5250_TUI_CONFIG;
  return join(dirname(tokenDir(env, platform)), 'sites.json');
}

/** A site as the console terminal stores it; the password is clear text by its design. */
export interface EnrollSite {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  trustAnyCertificate: boolean;
  user: string;
  password: string;
  screenSize: string;
  codePage: number;
  deviceName: string;
  autoSignon: boolean;
}

interface SitesFile {
  sites?: Array<Record<string, unknown> & { name?: string }>;
  lastUsed?: string;
  [k: string]: unknown;
}

function parseSites(existing: string | undefined): SitesFile {
  if (!existing || !existing.trim()) return { sites: [], lastUsed: '' };
  const root = JSON.parse(existing) as SitesFile;
  if (!Array.isArray(root.sites)) root.sites = [];
  return root;
}

const sameName = (a: string | undefined, b: string): boolean => (a ?? '').toLowerCase() === b.toLowerCase();

/**
 * Writes (or replaces, by name as the console terminal matches it: case-insensitively)
 * one site in the sites file's text. Fields of an existing entry this call does not know
 * (demo, say) are kept.
 */
export function enrollSite(existing: string | undefined, site: EnrollSite): string {
  const root = parseSites(existing);
  const sites = root.sites!;
  const i = sites.findIndex((s) => sameName(s.name, site.name));
  if (i >= 0) sites[i] = { ...sites[i], ...site };
  else sites.push({ ...site });
  return JSON.stringify(root, null, 2) + '\n';
}

/** Removes the site called name; undefined when there is none. */
export function removeSite(existing: string | undefined, name: string): string | undefined {
  const root = parseSites(existing);
  const before = root.sites!.length;
  root.sites = root.sites!.filter((s) => !sameName(s.name, name));
  if (root.sites.length === before) return undefined;
  if (sameName(root.lastUsed, name)) root.lastUsed = '';
  return JSON.stringify(root, null, 2) + '\n';
}

/** user@host of the site called name in the sites file's text; '' when there is none (or the text is not JSON). */
export function enrolledUser(existing: string | undefined, name: string): string {
  try {
    const site = parseSites(existing).sites!.find((s) => sameName(s.name, name));
    if (!site) return '';
    const user = typeof site.user === 'string' ? site.user : '';
    const host = typeof site.host === 'string' ? site.host : '';
    return user || host ? `${user}@${host}` : '';
  } catch {
    return '';
  }
}

/** Whether a .mcp.json text already starts the tn5250 server. */
export function mcpHasServer(existing: string | undefined): boolean {
  if (!existing || !existing.trim()) return false;
  try {
    const root = JSON.parse(existing) as { mcpServers?: unknown };
    return !!root.mcpServers && typeof root.mcpServers === 'object' && 'tn5250' in (root.mcpServers as Record<string, unknown>);
  } catch {
    return false;
  }
}

/** Reads the token files, newest first; unreadable ones are deleted. */
export function listTokens(dir: string = tokenDir()): AgentToken[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: AgentToken[] = [];
  for (const n of names) {
    const path = join(dir, n);
    try {
      const t = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentToken>;
      if (typeof t.addr !== 'string' || typeof t.token !== 'string') throw new Error('bad');
      out.push({ pid: Number(t.pid) || 0, addr: t.addr, token: t.token, started: String(t.started ?? ''), label: t.label, path });
    } catch {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
  }
  return out.sort((a, b) => b.started.localeCompare(a.started));
}

/** Where the console terminal's binary is: the setting, else PATH, else the installer's folders. */
export function findBinary(
  setting: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = (p) => {
    try {
      accessSync(p, constants.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
): string | undefined {
  if (setting.trim()) return setting.trim();
  const name = platform === 'win32' ? 'tn5250-tui.exe' : 'tn5250-tui';
  const dirs = (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  if (platform === 'win32') dirs.push(join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'tn5250-tui'));
  else dirs.push(join(homedir(), '.local', 'bin'), '/usr/local/bin', '/usr/bin');
  for (const d of dirs) {
    const p = join(d, name);
    if (exists(p)) return p;
  }
  return undefined;
}

/** One request/answer exchange on a fresh connection: hello, then list; resolves the sessions. */
export function fetchSessions(token: Pick<AgentToken, 'addr' | 'token'>, timeoutMs = 2000): Promise<AgentSession[]> {
  return new Promise((resolve, reject) => {
    const [host, portText] = splitAddr(token.addr);
    let buf = '';
    let greeted = false;
    let settled = false;
    const done = (err?: Error, sessions?: AgentSession[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(sessions ?? []);
    };
    const timer = setTimeout(() => done(new Error('timeout')), timeoutMs);
    const sock: Socket = createConnection({ host, port: Number(portText) }, () => {
      sock.write(JSON.stringify({ t: 'hello', token: token.token }) + '\n');
    });
    sock.setEncoding('utf8');
    sock.on('error', (e) => done(e));
    sock.on('close', () => done(new Error('closed')));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: WireMsg;
        try {
          m = JSON.parse(line) as WireMsg;
        } catch {
          continue;
        }
        if (m.t === 'error') return done(new Error(m.text || 'error'));
        if (m.t === 'sessions') {
          if (!greeted) {
            greeted = true;
            sock.write(JSON.stringify({ t: 'bye' }) + '\n');
            return done(undefined, m.sessions ?? []);
          }
        }
      }
    });
  });
}

function splitAddr(addr: string): [string, string] {
  const i = addr.lastIndexOf(':');
  return i < 0 ? [addr, '0'] : [addr.slice(0, i), addr.slice(i + 1)];
}

/** The shell arguments that attach a terminal to one session of a server. */
export function attachArgs(token: Pick<AgentToken, 'addr' | 'token'>, session: string): string[] {
  return ['attach', '--addr', token.addr, '--token', token.token, session];
}

/** The `.mcp.json` entry for Claude Code, merged into an existing file's text (or a fresh one). */
export function mergeMcpJson(existing: string | undefined, opts: { binary: string; site: string; readOnly: boolean }): string {
  let root: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  if (existing && existing.trim()) {
    root = JSON.parse(existing) as typeof root;
  }
  const args = ['mcp'];
  if (opts.site.trim()) args.push('--site', opts.site.trim());
  if (opts.readOnly) args.push('--read-only');
  root.mcpServers = { ...(root.mcpServers ?? {}), tn5250: { command: opts.binary, args } };
  return JSON.stringify(root, null, 2) + '\n';
}
