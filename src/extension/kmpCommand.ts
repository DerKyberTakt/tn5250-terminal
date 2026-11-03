import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { importKmp } from '../shared/kmpImport';
import { readDefaults, readSessions, writeDefaults, writeSessions } from './settingsStore';

/** Where ACS keeps its keyboard maps; the picker opens there when the folder exists. */
function acsEmulatorDir(): vscode.Uri | undefined {
  const dir = path.join(os.homedir(), 'Documents', 'IBM', 'iAccessClient', 'Emulator');
  return fs.existsSync(dir) ? vscode.Uri.file(dir) : undefined;
}

/** Picks a .kmp file and reads its key assignments; undefined when cancelled or when nothing usable is in it. */
export async function pickKmp(): Promise<ReturnType<typeof importKmp> | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Import ACS keyboard map',
    canSelectMany: false,
    defaultUri: acsEmulatorDir(),
    filters: { 'ACS keyboard map': ['kmp'], 'All files': ['*'] },
  });
  const file = picked?.[0];
  if (!file) return undefined;
  const text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
  const result = importKmp(text);
  if (!Object.keys(result.keymap).length) {
    void vscode.window.showWarningMessage('TN5250: no usable key assignments found in that file.');
    return undefined;
  }
  return result;
}

/** Picks a .kmp file and merges its key assignments into the defaults (-1) or a saved session. */
export async function importKmpInteractive(target: number): Promise<void> {
  const result = await pickKmp();
  if (!result) return;
  const count = Object.keys(result.keymap).length;
  if (target < 0) {
    const d = readDefaults();
    await writeDefaults({ ...d, keymap: { ...d.keymap, ...result.keymap } });
  } else {
    const sessions = readSessions();
    const s = sessions[target];
    if (!s) return;
    s.keymap = { ...(s.keymap ?? {}), ...result.keymap };
    await writeSessions(sessions);
  }
  const skipped = result.skipped.length ? `, ${result.skipped.length} skipped` : '';
  void vscode.window.showInformationMessage(`TN5250: imported ${count} key assignment(s)${skipped}.`);
}
