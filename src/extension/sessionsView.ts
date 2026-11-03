import * as vscode from 'vscode';
import type { TerminalSettings } from '../shared/settings';
import { resolvedSessions } from './settingsStore';
import { TerminalPanel } from './terminalPanel';

type Icon = { light: vscode.Uri; dark: vscode.Uri };

/** A saved connection; expands to its open tabs. */
export class SessionItem extends vscode.TreeItem {
  constructor(
    readonly profile: TerminalSettings,
    readonly index: number,
    readonly tabs: TerminalPanel[],
    icons: { on: Icon; off: Icon },
  ) {
    super(profile.name || profile.host, tabs.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    const live = tabs.filter((t) => t.connected).length;
    const where = profile.host ? `${profile.host}:${profile.port}${profile.tls ? ' TLS' : ''} ${profile.screenSize}` : 'no host yet - click to edit';
    this.description = live ? `${live} connected · ${where}` : where;
    const details = `${profile.host}:${profile.port}\n${profile.screenSize}, CCSID ${profile.codePage}${profile.deviceName ? `, device ${profile.deviceName}` : ''}`;
    this.tooltip = tabs.length ? `Click: show its tab (the plug icon opens another)\n${details}` : `Click: connect (new tab)\n${details}`;
    this.iconPath = live ? icons.on : icons.off;
    this.contextValue = tabs.length ? 'session-open' : 'session';
    this.id = `session:${profile.name}@${profile.host}:${index}`;
    this.command = tabs.length ? { command: 'tn5250.revealSession', title: 'Show', arguments: [this] } : { command: 'tn5250.connectSession', title: 'Connect', arguments: [this] };
  }

  /** The tab shown most recently, for a click on the session. */
  get latestTab(): TerminalPanel | undefined {
    return [...this.tabs].sort((a, b) => b.activatedAt - a.activatedAt)[0];
  }
}

/** One open terminal tab under its session. */
export class TabItem extends vscode.TreeItem {
  constructor(readonly panel: TerminalPanel) {
    super(panel.title, vscode.TreeItemCollapsibleState.None);
    this.description = panel.connected ? 'connected' : 'disconnected';
    this.tooltip = `${panel.title}\n${panel.connected ? 'Connected' : 'Disconnected'}${panel.profile?.deviceName ? `, device ${panel.profile.deviceName}` : ''}\nClick: show this tab`;
    this.iconPath = new vscode.ThemeIcon(panel.connected ? 'window' : 'debug-disconnect');
    this.contextValue = panel.connected ? 'tab' : 'tab-off';
    this.id = `tab:${panel.sessionLetter}`;
    this.command = { command: 'tn5250.revealTab', title: 'Show', arguments: [this] };
  }
}

/** Open tabs that do not belong to a saved connection (ad hoc hosts). */
export class GroupItem extends vscode.TreeItem {
  constructor(readonly tabs: TerminalPanel[]) {
    super('Unsaved connections', vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${tabs.length}`;
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'group';
    this.id = 'group:adhoc';
  }
}

export type SessionNode = SessionItem | TabItem | GroupItem;

/** The "Sessions" tree in the TN5250 side bar: connected sessions first, their open tabs underneath. */
export class SessionsProvider implements vscode.TreeDataProvider<SessionNode> {
  private readonly changed = new vscode.EventEmitter<SessionNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly icons: { on: Icon; off: Icon };
  private view: vscode.TreeView<SessionNode> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The item whose row was just clicked: it gets a fresh id on the next build, so VS Code drops its selection. */
  private bumped: string | undefined;
  private nonce = 0;

  constructor(context: vscode.ExtensionContext) {
    const media = (name: string): vscode.Uri => vscode.Uri.joinPath(context.extensionUri, 'media', name);
    this.icons = { on: { light: media('session-on.svg'), dark: media('session-on.svg') }, off: { light: media('session-off.svg'), dark: media('session-off.svg') } };
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tn5250')) this.refresh();
      }),
    );
    const onTabs = (): void => this.refresh();
    TerminalPanel.onDidChange.add(onTabs);
    context.subscriptions.push({ dispose: () => TerminalPanel.onDidChange.delete(onTabs) });
  }

  /** The tree view this provider feeds, for the badge and the "n connected" description. */
  attach(view: vscode.TreeView<SessionNode>): void {
    this.view = view;
    this.updateBadge();
  }

  /**
   * Drops the selection of a clicked row. VS Code keeps selection by item id across a refresh,
   * and a selected row keeps its inline actions visible; a new id makes it a new row.
   */
  deselect(item: vscode.TreeItem): void {
    this.bumped = item.id;
    this.nonce++;
    this.refresh();
  }

  /** Refreshes a little later: tab events come in bursts (status + title + active). */
  refresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.changed.fire(undefined);
      this.updateBadge();
    }, 60);
  }

  private updateBadge(): void {
    if (!this.view) return;
    const n = [...TerminalPanel.open].filter((p) => p.profile && p.connected).length;
    this.view.badge = n ? { value: n, tooltip: `${n} connected` } : undefined;
    this.view.description = n ? `${n} connected` : undefined;
  }

  getTreeItem(element: SessionNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SessionNode): SessionNode[] {
    if (element instanceof SessionItem) return element.tabs.map((p) => this.bump(new TabItem(p)));
    if (element instanceof GroupItem) return element.tabs.map((p) => this.bump(new TabItem(p)));
    if (element) return [];
    const open = [...TerminalPanel.open].filter((p) => p.profile);
    const claimed = new Set<TerminalPanel>();
    const items = resolvedSessions().map((p, i) => {
      const tabs = open.filter((t) => t.profile?.name === p.name && t.profile?.host === p.host);
      for (const t of tabs) claimed.add(t);
      return new SessionItem(p, i, tabs, this.icons);
    });
    if (vscode.workspace.getConfiguration('tn5250').get<string>('sessionsSort', 'manual') === 'name') {
      items.sort((a, b) => a.profile.name.localeCompare(b.profile.name, undefined, { sensitivity: 'base' }));
    }
    // Sessions with an open tab first (connected before disconnected), the rest in their order.
    const rank = (s: SessionItem): number => (s.tabs.some((t) => t.connected) ? 0 : s.tabs.length ? 1 : 2);
    const sorted = items.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s);
    const adhoc = open.filter((t) => !claimed.has(t));
    const roots: SessionNode[] = adhoc.length ? [...sorted, new GroupItem(adhoc)] : sorted;
    return roots.map((r) => this.bump(r));
  }

  private bump<T extends SessionNode>(item: T): T {
    if (this.bumped && item.id === this.bumped) item.id = `${item.id}#${this.nonce}`;
    return item;
  }
}
