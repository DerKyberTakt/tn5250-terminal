import * as vscode from 'vscode';
import { closeOrphans, describeEntry, formatDuration, pushHistory, touchEntries, type HistoryEntry } from '../shared/history';

const HISTORY_KEY = 'tn5250.history';

/** Where past connections are kept (VS Code global state), with the settings that govern it. */
export class HistoryStore {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    // Entries left open by a previous extension host end at their last heartbeat.
    const list = this.list();
    if (list.some((e) => !e.end)) void context.globalState.update(HISTORY_KEY, closeOrphans(list)).then(() => this.changed.fire());
  }

  get enabled(): boolean {
    return vscode.workspace.getConfiguration('tn5250').get<boolean>('history.enabled', true);
  }

  private get limit(): number {
    return vscode.workspace.getConfiguration('tn5250').get<number>('history.limit', 300);
  }

  list(): HistoryEntry[] {
    return this.context.globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
  }

  /** Adds or updates an entry (by id). */
  record(entry: HistoryEntry): void {
    if (!this.enabled) return;
    void this.context.globalState.update(HISTORY_KEY, pushHistory(this.list(), entry, this.limit)).then(() => this.changed.fire());
  }

  /** Heartbeat for the tabs still connected, so a crash does not leave their entries open for ever. */
  touchOpen(ids: string[]): void {
    if (!ids.length) return;
    void this.context.globalState.update(HISTORY_KEY, touchEntries(this.list(), ids)).then(() => this.changed.fire());
  }

  remove(id: string): void {
    void this.context.globalState.update(HISTORY_KEY, this.list().filter((e) => e.id !== id)).then(() => this.changed.fire());
  }

  clear(): void {
    void this.context.globalState.update(HISTORY_KEY, []).then(() => this.changed.fire());
  }
}

export class HistoryItem extends vscode.TreeItem {
  constructor(readonly entry: HistoryEntry) {
    super(entry.sessionName || entry.host, vscode.TreeItemCollapsibleState.None);
    this.description = describeEntry(entry);
    this.iconPath = new vscode.ThemeIcon(entry.end ? 'history' : 'window');
    this.contextValue = entry.end ? 'history' : 'history-open'; // no "Connect again" while it is open
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${entry.sessionName || entry.host}**\n\n`);
    for (const [k, v] of detailRows(entry)) md.appendMarkdown(`${k}: ${v}  \n`);
    md.appendMarkdown(entry.end ? '\nClick twice for details and actions.' : '\nStill open: use its tab. Click twice for details.');
    this.tooltip = md;
    this.command = { command: 'tn5250.historyClick', title: 'Details', arguments: [this] };
  }
}

/** The rows of the details list: label, value. */
export function detailRows(e: HistoryEntry): Array<[string, string]> {
  const fmt = (t: number): string => new Date(t).toLocaleString();
  const ended: Record<NonNullable<HistoryEntry['endedBy']>, string> = { user: 'you (disconnect)', host: 'the host', error: 'an error', reload: 'Save & Reload', closed: 'the tab was closed' };
  return [
    ['Display', e.deviceName || '(assigned by the host)'],
    ['System', `${e.host}:${e.port}${e.tls ? ' (TLS)' : ''}`],
    ['User', e.user || '(not seen)'],
    ['Session', e.sessionName || '(unsaved host)'],
    ['Tab', e.tabTitle],
    ['Screen', e.screenSize],
    ['Started', fmt(e.start)],
    ['Ended', e.end ? fmt(e.end) : 'still open'],
    ['Duration', formatDuration((e.end ?? Date.now()) - e.start)],
    ['Ended by', e.endedBy ? ended[e.endedBy] : e.end ? '-' : 'still open'],
  ];
}

/** The "History" tree in the TN5250 side bar: past connections, newest first. */
export class HistoryProvider implements vscode.TreeDataProvider<HistoryItem> {
  private readonly changed = new vscode.EventEmitter<HistoryItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly store: HistoryStore,
    context: vscode.ExtensionContext,
  ) {
    context.subscriptions.push(store.onDidChange(() => this.changed.fire(undefined)));
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: HistoryItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: HistoryItem): HistoryItem[] {
    if (element) return [];
    return this.store.list().map((e) => new HistoryItem(e));
  }
}
