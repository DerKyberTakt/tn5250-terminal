import * as vscode from 'vscode';
import { TerminalPanel } from './terminalPanel';
import { SettingsPanel } from './settingsPanel';
import { SessionItem, SessionsProvider, TabItem } from './sessionsView';
import { HistoryItem, HistoryProvider, HistoryStore, detailRows } from './historyView';
import { resolveSettings } from '../shared/settings';
import { readDefaults, readSessions, removeSessionAt, resolvedSessions, writeSessions } from './settingsStore';
import { importKmpInteractive } from './kmpCommand';
import { importConnectionsInteractive } from './importCommand';
import { watchRecording, MacroRecorder } from '../shared/macros';
import { macroStore, manageMacros, pickAndRun, saveRecordedMacro, stopMacro } from './macros';
import { setCertPassphraseInteractive, setPasswordInteractive } from './secrets';

const LAST_SESSION_KEY = 'tn5250.lastSession';

function parseHostInput(input: string, defaultPort: number): { host: string; port: number } | undefined {
  const text = input.trim();
  if (!text) return undefined;
  const m = /^(\[[^\]]+\]|[^:\s]+)(?::(\d{1,5}))?$/.exec(text);
  if (!m) return undefined;
  const host = (m[1] as string).replace(/^\[|\]$/g, '');
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (port < 1 || port > 65535) return undefined;
  return { host, port };
}

async function saveTrace(): Promise<void> {
  const panel = TerminalPanel.active;
  const trace = panel?.exportTrace();
  if (!panel || !trace) {
    void vscode.window.showInformationMessage('TN5250: focus a connected terminal tab first.');
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: 'Save TN5250 session trace',
    defaultUri: vscode.Uri.file(`tn5250-trace-${panel.title.replace(/[^\w.-]+/g, '_')}.json`),
    filters: { JSON: ['json'] },
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(trace, null, 1) + '\n', 'utf8'));
  void vscode.window.showInformationMessage(`TN5250: trace saved to ${target.fsPath}. It contains screen contents (what was typed into non-display fields is blanked); share it only with people allowed to see them.`);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('TN5250');
  context.subscriptions.push(output);

  const history = new HistoryStore(context);
  TerminalPanel.history = history;
  const historyProvider = new HistoryProvider(history, context);
  const historyView = vscode.window.createTreeView('tn5250.history', { treeDataProvider: historyProvider });
  context.subscriptions.push(historyView);

  const sessions = new SessionsProvider(context);
  const sessionsView = vscode.window.createTreeView('tn5250.sessions', { treeDataProvider: sessions });
  sessions.attach(sessionsView);
  context.subscriptions.push(sessionsView);
  // Every minute: the open history entries of connected tabs are marked alive, so an entry
  // left behind by a crash ends at its last heartbeat instead of staying "open".
  const heartbeat = setInterval(() => history.touchOpen([...TerminalPanel.open].flatMap((p) => (p.historyId ? [p.historyId] : []))), 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(heartbeat) });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'tn5250.connectPrevious';
  context.subscriptions.push(status);
  TerminalPanel.onActiveChanged = () => {
    const p = TerminalPanel.active;
    if (p) {
      status.text = `$(terminal) ${p.title}${p.connected ? '' : ' (disconnected)'}`;
      status.tooltip = 'TN5250 terminal';
      status.show();
    } else {
      status.hide();
    }
  };

  const openSession = (index: number): void => {
    const profile = resolvedSessions()[index];
    if (!profile) return;
    if (!profile.host.trim()) {
      SettingsPanel.show(context, output, index);
      return;
    }
    void context.globalState.update(LAST_SESSION_KEY, profile.name);
    TerminalPanel.create(context, output, profile);
  };

  const register = (command: string, handler: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  register('tn5250.newConnection', async () => {
    const defaultPort = readDefaults().port;
    const input = await vscode.window.showInputBox({
      title: 'TN5250: New Connection',
      prompt: 'IBM i host name or address, optionally with :port. The rest is edited in Settings.',
      placeHolder: `myibmi  or  myibmi:${defaultPort}`,
      ignoreFocusOut: true,
      validateInput: (v) => (parseHostInput(v, defaultPort) ? undefined : 'Enter host or host:port'),
    });
    const parsed = input ? parseHostInput(input, defaultPort) : undefined;
    if (!parsed) return;
    const list = readSessions();
    list.push({ host: parsed.host, port: parsed.port, name: parsed.host });
    await writeSessions(list);
    sessions.refresh();
    SettingsPanel.show(context, output, list.length - 1);
  });
  register('tn5250.sortSessions', async () => {
    const cfg = vscode.workspace.getConfiguration('tn5250');
    const next = cfg.get<string>('sessionsSort', 'manual') === 'name' ? 'manual' : 'name';
    await cfg.update('sessionsSort', next, vscode.ConfigurationTarget.Global);
    void vscode.window.setStatusBarMessage(`TN5250: connections sorted ${next === 'name' ? 'by name' : 'in saved order'}`, 2500);
  });
  register('tn5250.refreshSessions', () => sessions.refresh());
  register('tn5250.connectPrevious', () => {
    const list = resolvedSessions();
    const last = context.globalState.get<string>(LAST_SESSION_KEY);
    const index = Math.max(0, list.findIndex((s) => s.name === last));
    if (!list.length) {
      void vscode.commands.executeCommand('tn5250.newConnection');
      return;
    }
    openSession(index);
  });
  register('tn5250.connectSession', (item: SessionItem) => {
    if (item?.profile) openSession(item.index);
    if (item) sessions.deselect(item); // so the row's hover actions do not stick after the click
  });
  register('tn5250.revealSession', (item: SessionItem) => {
    const tab = item?.latestTab;
    if (tab) tab.reveal();
    else if (item?.profile) openSession(item.index);
    if (item) sessions.deselect(item);
  });
  register('tn5250.revealTab', (item: TabItem) => {
    item?.panel.reveal();
    if (item) sessions.deselect(item);
  });
  register('tn5250.closeTab', (item: TabItem) => item?.panel.close());
  register('tn5250.reconnectTab', (item: TabItem) => {
    item?.panel.connect();
    item?.panel.reveal();
  });
  register('tn5250.editSession', (item: SessionItem) => SettingsPanel.show(context, output, item?.index ?? -1));
  register('tn5250.duplicateSession', async (item: SessionItem) => {
    const list = readSessions();
    const src = list[item?.index ?? -1];
    if (!src) return;
    const copy = { ...src, name: `${src.name ?? src.host} (copy)` };
    list.splice((item?.index ?? 0) + 1, 0, copy);
    await writeSessions(list);
    sessions.refresh();
    SettingsPanel.show(context, output, (item?.index ?? 0) + 1);
  });
  register('tn5250.removeSession', async (item: SessionItem) => {
    if (!item?.profile) return;
    const ok = await vscode.window.showWarningMessage(`Remove connection "${item.profile.name}"?`, { modal: true }, 'Remove');
    if (ok === 'Remove') await removeSessionAt(item.index, context.secrets);
    sessions.refresh();
  });
  register('tn5250.openSettings', () => {
    const list = resolvedSessions();
    const last = context.globalState.get<string>(LAST_SESSION_KEY);
    const index = list.length ? Math.max(0, list.findIndex((s) => s.name === last)) : -1;
    SettingsPanel.show(context, output, index);
  });
  register('tn5250.setCertPassphrase', () => setCertPassphraseInteractive(context, -1));
  register('tn5250.newTab', () => {
    const p = TerminalPanel.active?.profile;
    if (p) TerminalPanel.create(context, output, p);
    else void vscode.commands.executeCommand('tn5250.connectPrevious');
  });
  register('tn5250.disconnectAll', async () => {
    const open = [...TerminalPanel.open].filter((p) => p.connected);
    if (!open.length) return;
    if (open.length > 1 && readDefaults().warnOnCloseMultiple) {
      const ok = await vscode.window.showWarningMessage(`Disconnect ${open.length} sessions?`, { modal: true }, 'Disconnect');
      if (ok !== 'Disconnect') return;
    }
    for (const p of open) p.disconnect();
  });
  register('tn5250.importKmp', () => importKmpInteractive(-1));
  register('tn5250.importConnections', async () => {
    const outcome = await importConnectionsInteractive();
    if (!outcome) return;
    if (!outcome.imported) {
      void vscode.window.showInformationMessage(outcome.message);
      return;
    }
    sessions.refresh();
    const choice = await vscode.window.showInformationMessage(outcome.message, 'Open Settings', 'Undo');
    if (choice === 'Open Settings') SettingsPanel.show(context, output, outcome.firstIndex);
    if (choice === 'Undo') {
      // The saved list as it was before the import; the import changed nothing else.
      await writeSessions(outcome.previous);
      sessions.refresh();
      void vscode.window.showInformationMessage('TN5250: import undone, the connections are as they were.');
    }
  });
  register('tn5250.setPassword', () => setPasswordInteractive(context, -1));

  // Macros: recorded in the active tab, run by key or from the lists.
  macroStore.init(context);
  const recording = (): TerminalPanel | undefined => [...TerminalPanel.open].find((p) => p.recorder);
  let recordingWatch: (() => void) | undefined;
  const startRecording = (): void => {
    const panel = TerminalPanel.active;
    if (!panel?.profile) {
      void vscode.window.showInformationMessage('TN5250: open a terminal tab first.');
      return;
    }
    if (recording()) {
      void vscode.window.showInformationMessage('TN5250: a recording is already running; stop it first.');
      return;
    }
    panel.recorder = new MacroRecorder();
    // A forgotten recording: a reminder every 5 minutes, and an end after 5 minutes without a keystroke.
    recordingWatch = watchRecording(panel.recorder, {
      onIdle: () => {
        if (!recording()) return;
        void vscode.window.showWarningMessage('TN5250: recording stopped, nothing typed for 5 minutes.');
        void vscode.commands.executeCommand('tn5250.stopRecording');
      },
      onReminder: (minutes) => void vscode.window.showWarningMessage(`TN5250: still recording a macro (${minutes} min). Run TN5250: Stop Recording when done.`),
    });
    void vscode.window.showInformationMessage(`TN5250: recording in ${panel.title}. What you type and press goes into the macro; run TN5250: Stop Recording when done.`);
  };
  register('tn5250.recordMacro', startRecording);
  register('tn5250.stopRecording', async () => {
    recordingWatch?.();
    recordingWatch = undefined;
    const panel = recording();
    if (!panel?.recorder) {
      void vscode.window.showInformationMessage('TN5250: no recording is running.');
      return;
    }
    const recorder = panel.recorder;
    panel.recorder = undefined;
    await saveRecordedMacro(recorder);
  });
  register('tn5250.runMacro', () => pickAndRun(TerminalPanel.active?.profile ? TerminalPanel.active.macroSession() : undefined, output));
  register('tn5250.stopMacro', () => stopMacro());
  register('tn5250.macros', () => manageMacros(TerminalPanel.active?.profile ? TerminalPanel.active.macroSession() : undefined, output, startRecording));
  context.subscriptions.push(macroStore.onDidChange(() => [...TerminalPanel.open].forEach((p) => p.refreshConfig())));
  register('tn5250.printScreen', async () => {
    const text = TerminalPanel.active?.screenText();
    if (text === undefined) {
      void vscode.window.showInformationMessage('TN5250: focus a connected terminal tab first.');
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ content: text, language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { preview: false });
  });
  // History: one click selects, a second click within 400 ms opens the details.
  let lastHistoryClick: { id: string; at: number } | undefined;
  const historyConnect = (item: HistoryItem | undefined): void => {
    const e = item?.entry;
    if (!e) return;
    if (!e.end) {
      void vscode.window.setStatusBarMessage('TN5250: that connection is still open; use its tab', 3000);
      return;
    }
    const index = resolvedSessions().findIndex((s) => e.sessionName && s.name === e.sessionName && s.host === e.host);
    if (index >= 0) openSession(index);
    else TerminalPanel.create(context, output, resolveSettings(readDefaults(), { host: e.host, port: e.port, tls: e.tls, name: '', screenSize: e.screenSize as '24x80' | '27x132' }));
  };
  const historyDetails = async (item: HistoryItem): Promise<void> => {
    const e = item.entry;
    type Pick = vscode.QuickPickItem & { act?: 'connect' | 'copy' | 'remove' };
    const items: Pick[] = [
      ...detailRows(e).map(([label, description]) => ({ label, description })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...(e.end ? [{ label: '$(plug) Connect again', act: 'connect' as const }] : []),
      { label: '$(copy) Copy device name', act: 'copy' as const, description: e.deviceName || undefined },
      { label: '$(trash) Remove entry', act: 'remove' as const },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `${e.sessionName || e.host} - ${new Date(e.start).toLocaleString()}`, placeHolder: 'Connection details; pick an action or press Esc' });
    if (pick?.act === 'connect') historyConnect(item);
    else if (pick?.act === 'copy') {
      await vscode.env.clipboard.writeText(e.deviceName);
      void vscode.window.setStatusBarMessage(`TN5250: ${e.deviceName || 'nothing'} copied`, 2500);
    } else if (pick?.act === 'remove') history.remove(e.id);
  };
  register('tn5250.historyClick', (item: HistoryItem) => {
    if (!item?.entry) return;
    const now = Date.now();
    if (lastHistoryClick?.id === item.entry.id && now - lastHistoryClick.at < 400) {
      lastHistoryClick = undefined;
      void historyDetails(item);
    } else lastHistoryClick = { id: item.entry.id, at: now };
  });
  register('tn5250.historyDetails', (item: HistoryItem) => (item?.entry ? historyDetails(item) : undefined));
  register('tn5250.historyConnect', historyConnect);
  register('tn5250.historyRemove', (item: HistoryItem) => (item?.entry ? history.remove(item.entry.id) : undefined));
  register('tn5250.clearHistory', async () => {
    const ok = await vscode.window.showWarningMessage('Clear the connection history?', { modal: true }, 'Clear');
    if (ok === 'Clear') history.clear();
  });
  register('tn5250.demoScreen', () => TerminalPanel.create(context, output));
  register('tn5250.disconnect', () => TerminalPanel.active?.disconnect());
  register('tn5250.reconnect', () => TerminalPanel.active?.connect());
  register('tn5250.saveTrace', saveTrace);
  register('tn5250.toggleScreenSize', () => TerminalPanel.active?.toggleScreenSize());
  register('tn5250.toggleKeyDebug', () => TerminalPanel.active?.toggleKeyOverlay());
  // Bound to every key the terminal consumes (see contributes.keybindings) so
  // the default VS Code binding for that key stays quiet while a terminal tab
  // is focused. The webview has already handled the key by the time this runs.
  register('tn5250.shadowKey', () => undefined);

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(TerminalPanel.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Thenable<void> {
        TerminalPanel.restore(context, output, panel, state);
        return Promise.resolve();
      },
    }),
  );
}

export function deactivate(): void {
  // Panels are disposed through context.subscriptions.
}
