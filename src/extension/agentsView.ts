import * as vscode from 'vscode';
import { attachArgs, fetchSessions, findBinary, listTokens, mergeMcpJson, type AgentSession, type AgentToken } from './agentClient';

/** A running `tn5250-tui mcp` server (one Claude Code session, usually). */
export class AgentServerItem extends vscode.TreeItem {
  constructor(
    readonly token: AgentToken,
    readonly sessions: AgentSession[] | undefined,
  ) {
    super(token.label || `pid ${token.pid}`, vscode.TreeItemCollapsibleState.Expanded);
    this.description = sessions ? `${sessions.length} session${sessions.length === 1 ? '' : 's'} · ${token.addr}` : `not answering · ${token.addr}`;
    this.iconPath = new vscode.ThemeIcon(sessions ? 'server-process' : 'debug-disconnect');
    this.contextValue = 'agent-server';
    this.id = `agent-server:${token.addr}`;
    this.tooltip = `tn5250-tui mcp, pid ${token.pid}\nstarted ${token.started}\n${token.path}`;
  }
}

/** One 5250 session the agent holds. */
export class AgentSessionItem extends vscode.TreeItem {
  constructor(
    readonly token: AgentToken,
    readonly session: AgentSession,
  ) {
    super(session.session, vscode.TreeItemCollapsibleState.None);
    const state = session.connected ? (session.inhibited && session.inhibited !== 'none' ? 'host busy' : 'connected') : 'disconnected';
    this.description = [session.host, session.device, state].filter(Boolean).join(' · ');
    this.iconPath = new vscode.ThemeIcon(session.connected ? 'window' : 'debug-disconnect');
    this.contextValue = 'agent-session';
    this.id = `agent-session:${token.addr}/${session.session}`;
    this.tooltip = `${session.session} on ${session.host}${session.device ? ` (${session.device})` : ''}\n${state}, screen ${session.seq}\nClick: watch it in a terminal (read-only)`;
    this.command = { command: 'tn5250.agent.watch', title: 'Watch', arguments: [this] };
  }
}

export type AgentNode = AgentServerItem | AgentSessionItem;

/**
 * The "Agent Sessions" view: the console terminal's MCP servers found through their token
 * files, and the sessions each one holds. Polled every few seconds while the view is
 * visible and the feature is on.
 */
export class AgentsProvider implements vscode.TreeDataProvider<AgentNode> {
  private readonly changed = new vscode.EventEmitter<AgentNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private view: vscode.TreeView<AgentNode> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private servers: AgentServerItem[] = [];
  private readonly terminals = new Map<string, vscode.Terminal>();

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tn5250.agent')) this.schedule();
      }),
      vscode.window.onDidCloseTerminal((t) => {
        for (const [k, v] of this.terminals) if (v === t) this.terminals.delete(k);
      }),
      { dispose: () => this.stop() },
    );
  }

  static get enabled(): boolean {
    return vscode.workspace.getConfiguration('tn5250').get<boolean>('agent.enabled', false);
  }

  attach(view: vscode.TreeView<AgentNode>): void {
    this.view = view;
    this.context.subscriptions.push(view.onDidChangeVisibility(() => this.schedule()));
    this.schedule();
  }

  /** Starts or stops the poll by visibility and the setting. */
  private schedule(): void {
    void vscode.commands.executeCommand('setContext', 'tn5250.agent.enabled', AgentsProvider.enabled);
    const want = AgentsProvider.enabled && (this.view?.visible ?? false);
    if (want && !this.timer) {
      this.timer = setInterval(() => void this.poll(), 3000);
      void this.poll();
    } else if (!want) {
      this.stop();
      if (!AgentsProvider.enabled) {
        this.servers = [];
        this.changed.fire(undefined);
      }
    }
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads the token files and asks every server for its sessions. */
  async poll(): Promise<void> {
    const tokens = listTokens();
    const servers = await Promise.all(
      tokens.map(async (t) => {
        try {
          return new AgentServerItem(t, await fetchSessions(t));
        } catch {
          return new AgentServerItem(t, undefined);
        }
      }),
    );
    const before = JSON.stringify(this.servers.map((s) => [s.id, s.description, s.sessions?.map((x) => [x.session, x.connected, x.inhibited])]));
    const after = JSON.stringify(servers.map((s) => [s.id, s.description, s.sessions?.map((x) => [x.session, x.connected, x.inhibited])]));
    this.servers = servers;
    if (before !== after) this.changed.fire(undefined);
    const n = servers.reduce((sum, s) => sum + (s.sessions?.filter((x) => x.connected).length ?? 0), 0);
    if (this.view) {
      this.view.badge = n ? { value: n, tooltip: `${n} agent session${n === 1 ? '' : 's'} connected` } : undefined;
      this.view.description = AgentsProvider.enabled ? (servers.length ? undefined : 'no server running') : 'off';
    }
  }

  refresh(): void {
    void this.poll();
  }

  getTreeItem(element: AgentNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AgentNode): AgentNode[] {
    if (element instanceof AgentServerItem) return (element.sessions ?? []).map((s) => new AgentSessionItem(element.token, s));
    if (element) return [];
    return this.servers;
  }

  /** The binary, or a message telling the user how to get it. */
  private binary(): string | undefined {
    const setting = vscode.workspace.getConfiguration('tn5250').get<string>('agent.binary', '');
    const bin = findBinary(setting);
    if (!bin) {
      void vscode.window
        .showWarningMessage('TN5250: tn5250-tui (the console terminal) was not found on PATH. Install it or set tn5250.agent.binary.', 'Open Settings')
        .then((pick) => pick && vscode.commands.executeCommand('workbench.action.openSettings', 'tn5250.agent.binary'));
    }
    return bin;
  }

  /** Opens (or shows) the terminal that watches one session. */
  watch(item: AgentSessionItem): vscode.Terminal | undefined {
    const key = `${item.token.addr}/${item.session.session}`;
    let term = this.terminals.get(key);
    if (!term) {
      const bin = this.binary();
      if (!bin) return undefined;
      term = vscode.window.createTerminal({
        name: `Agent ${item.session.session} · ${item.session.host}`,
        shellPath: bin,
        shellArgs: attachArgs(item.token, item.session.session),
        iconPath: new vscode.ThemeIcon('eye'),
        isTransient: true,
      });
      this.terminals.set(key, term);
    }
    term.show(false);
    return term;
  }

  /** Watches the session in a terminal moved into the editor area (a tab you can drag out). */
  async popOut(item: AgentSessionItem, where: 'editor' | 'window'): Promise<void> {
    const term = this.watch(item);
    if (!term) return;
    // The move commands act on the active terminal; show() made it so.
    await vscode.commands.executeCommand(where === 'editor' ? 'workbench.action.terminal.moveToEditor' : 'workbench.action.terminal.moveIntoNewWindow');
  }

  /** Writes (or merges) the Claude Code `.mcp.json` of the workspace. */
  async setup(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showInformationMessage('TN5250: open a folder first; .mcp.json goes into the workspace root.');
      return;
    }
    const cfg = vscode.workspace.getConfiguration('tn5250');
    const bin = findBinary(cfg.get<string>('agent.binary', '')) ?? 'tn5250-tui';
    const site = cfg.get<string>('agent.site', 'agent');
    const readOnly = cfg.get<boolean>('agent.readOnly', true);
    const target = vscode.Uri.joinPath(folder.uri, '.mcp.json');
    let existing: string | undefined;
    try {
      existing = Buffer.from(await vscode.workspace.fs.readFile(target)).toString('utf8');
    } catch {
      existing = undefined;
    }
    let text: string;
    try {
      text = mergeMcpJson(existing, { binary: bin, site, readOnly });
    } catch (e) {
      void vscode.window.showErrorMessage(`TN5250: ${target.fsPath} is not valid JSON (${(e as Error).message}); fix it or remove it first.`);
      return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    void vscode.window.showInformationMessage(
      `TN5250: ${target.fsPath} now starts tn5250-tui mcp for site "${site}"${readOnly ? ' (read-only)' : ''}. Add that site in tn5250-tui (:sites) with the agent's own user profile, then restart Claude Code in this folder.`,
    );
    await vscode.window.showTextDocument(target);
  }
}
