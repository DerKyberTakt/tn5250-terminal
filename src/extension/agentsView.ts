import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { attachArgs, endSession, enrollSite, enrolledUser, fetchSessions, findBinary, forgetToken, listTokens, mergeMcpJson, newlyConnected, removeSite, sessionKey, sitePasswordForm, sitesPath, writePrivateFile, type AgentSession, type AgentToken, type OpenViewer } from './agentClient';
import { installRelease, installedBinary, latestTag, tarExtract } from './agentInstall';
import { findPassword } from './secretKeys';
import { resolvedSessions } from './settingsStore';

type Icon = { light: vscode.Uri; dark: vscode.Uri };
/** The Sessions view's green (connected) and grey (off) session icons, shared so the two views read alike. */
export type AgentIcons = { on: Icon; off: Icon };

/** A running `tn5250-tui mcp` server (one Claude Code session, usually). */
export class AgentServerItem extends vscode.TreeItem {
  /** Sessions of this server connected to a host. */
  readonly connected: number;

  constructor(
    readonly token: AgentToken,
    readonly sessions: AgentSession[] | undefined,
    icons: AgentIcons,
  ) {
    super(token.label || `pid ${token.pid}`, sessions?.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.connected = sessions?.filter((s) => s.connected).length ?? 0;
    const idle = sessions ? sessions.length - this.connected : 0;
    const state = !sessions
      ? 'not answering'
      : this.connected
        ? `${this.connected} connected${idle ? ` · ${idle} disconnected` : ''}`
        : sessions.length
          ? `${sessions.length} disconnected`
          : 'idle';
    this.description = `${state} · ${token.addr}`;
    this.iconPath = !sessions ? new vscode.ThemeIcon('debug-disconnect') : this.connected ? icons.on : icons.off;
    this.contextValue = sessions ? 'agent-server' : 'agent-server-dead';
    this.id = `agent-server:${token.addr}`;
    this.tooltip =
      `tn5250-tui mcp, pid ${token.pid}\nstarted ${token.started}\n${token.path}` +
      (sessions ? '' : '\nNot answering: the server may have ended. Forget removes its entry; the view also drops servers whose process is gone.');
  }
}

/** One 5250 session the agent holds. */
export class AgentSessionItem extends vscode.TreeItem {
  constructor(
    readonly token: AgentToken,
    readonly session: AgentSession,
    icons: AgentIcons,
  ) {
    super(session.session, vscode.TreeItemCollapsibleState.None);
    const state = session.connected ? (session.inhibited && session.inhibited !== 'none' ? 'host busy' : 'connected') : 'disconnected';
    this.description = [session.host, session.device, state].filter(Boolean).join(' · ');
    this.iconPath = session.connected ? icons.on : icons.off;
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
  private period = 0;
  private servers: AgentServerItem[] = [];
  private readonly terminals = new Map<string, vscode.Terminal>();
  /** Connected sessions at the last poll; undefined before the first one. */
  private seen: Set<string> | undefined;
  /** Watch Next Agent Session: the next session that connects opens in the editor area, once. */
  private watchNextArmed = false;
  /** Viewers whose session ended, waiting a moment before they close. */
  private readonly closing = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly icons: AgentIcons;

  constructor(private readonly context: vscode.ExtensionContext) {
    const media = (name: string): vscode.Uri => vscode.Uri.joinPath(context.extensionUri, 'media', name);
    this.icons = { on: { light: media('session-on.svg'), dark: media('session-on.svg') }, off: { light: media('session-off.svg'), dark: media('session-off.svg') } };
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

  /** What happens when an agent session starts. */
  static get openViewer(): OpenViewer {
    const v = vscode.workspace.getConfiguration('tn5250').get<string>('agent.openViewer', 'off');
    return v === 'panel' || v === 'editor' || v === 'window' ? v : 'off';
  }

  attach(view: vscode.TreeView<AgentNode>): void {
    this.view = view;
    this.context.subscriptions.push(view.onDidChangeVisibility(() => this.schedule()));
    this.schedule();
  }

  /** Starts or stops the poll by visibility and the setting. */
  private schedule(): void {
    void vscode.commands.executeCommand('setContext', 'tn5250.agent.enabled', AgentsProvider.enabled);
    // A viewer that opens by itself needs the poll also while the view is hidden, and a short
    // period: a ten-second agent run is over before a three-second poll shows it.
    const auto = AgentsProvider.openViewer !== 'off' || this.watchNextArmed;
    const want = AgentsProvider.enabled && ((this.view?.visible ?? false) || auto);
    const period = auto ? 700 : 3000;
    if (want && (!this.timer || this.period !== period)) {
      this.stop();
      this.period = period;
      this.timer = setInterval(() => void this.poll(), period);
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
    this.period = 0;
  }

  /**
   * Reads the token files (servers whose process ended are dropped there) and asks every
   * server for its sessions. Servers with connected sessions come first, then idle ones,
   * then those that do not answer.
   */
  async poll(): Promise<void> {
    const tokens = listTokens();
    const servers = await Promise.all(
      tokens.map(async (t) => {
        try {
          return new AgentServerItem(t, await fetchSessions(t), this.icons);
        } catch {
          return new AgentServerItem(t, undefined, this.icons);
        }
      }),
    );
    const rank = (s: AgentServerItem): number => (s.connected ? 0 : s.sessions ? 1 : 2);
    servers.sort((a, b) => rank(a) - rank(b));
    const before = JSON.stringify(this.servers.map((s) => [s.id, s.description, s.sessions?.map((x) => [x.session, x.connected, x.inhibited])]));
    const after = JSON.stringify(servers.map((s) => [s.id, s.description, s.sessions?.map((x) => [x.session, x.connected, x.inhibited])]));
    this.servers = servers;
    if (before !== after) this.changed.fire(undefined);
    this.followSessions(servers);
    const n = servers.reduce((sum, s) => sum + s.connected, 0);
    if (this.view) {
      this.view.badge = n ? { value: n, tooltip: `${n} agent session${n === 1 ? '' : 's'} connected` } : undefined;
      const idle = servers.filter((s) => s.sessions).length;
      this.view.description = !AgentsProvider.enabled
        ? 'off'
        : n
          ? `${n} connected`
          : servers.length
            ? idle
              ? `${idle} server${idle === 1 ? '' : 's'} idle`
              : 'not answering'
            : 'no server running';
    }
  }

  /**
   * Opens a viewer for a session that just connected (the setting, or Watch Next Agent
   * Session), and closes the viewer of a session that ended a few seconds after it did, so a
   * viewer never sits on a dead session and the next one is not shown in an old viewer.
   */
  private followSessions(servers: AgentServerItem[]): void {
    const now = new Map<string, AgentSessionItem>();
    for (const srv of servers) {
      for (const s of srv.sessions ?? []) {
        if (s.connected) now.set(sessionKey(srv.token.addr, s.session), new AgentSessionItem(srv.token, s, this.icons));
      }
    }
    const keys = new Set(now.keys());
    const fresh = newlyConnected(this.seen, keys);
    this.seen = keys;
    for (const k of fresh) {
      const item = now.get(k);
      if (!item) continue;
      const how: OpenViewer = this.watchNextArmed ? 'editor' : AgentsProvider.openViewer;
      if (this.watchNextArmed) {
        this.watchNextArmed = false;
        this.schedule();
      }
      if (how !== 'off') void this.open(item, how, true);
    }
    for (const [k, term] of this.terminals) {
      if (keys.has(k)) {
        const t = this.closing.get(k);
        if (t) {
          clearTimeout(t);
          this.closing.delete(k);
        }
      } else if (!this.closing.has(k)) {
        this.closing.set(
          k,
          setTimeout(() => {
            this.closing.delete(k);
            this.terminals.delete(k);
            term.dispose();
          }, 4000),
        );
      }
    }
  }

  /** Watch Next Agent Session: arms the view so the next session that connects opens in the editor area. */
  watchNext(): void {
    this.watchNextArmed = true;
    this.schedule();
    void vscode.window.showInformationMessage('TN5250: the next agent session opens in the editor area as soon as it connects.');
  }

  /** Sign Off and Close: asks the session's server to type SIGNOFF (when a command line is there) and close the session. */
  async end(item: AgentSessionItem): Promise<void> {
    try {
      const signedOff = await endSession(item.token, item.session.session);
      void vscode.window.showInformationMessage(`TN5250: agent session ${item.session.session} on ${item.session.host} ${signedOff ? 'signed off and closed' : 'closed (no command line on its screen to sign off at)'}.`);
    } catch (e) {
      void vscode.window.showErrorMessage(`TN5250: could not end ${item.session.session}: ${(e as Error).message}`);
    }
    void this.poll();
  }

  /** Sign Off and Close All: every connected agent session of every server, after one confirmation. */
  async endAll(): Promise<void> {
    const all: AgentSessionItem[] = [];
    for (const srv of this.servers) for (const s of srv.sessions ?? []) if (s.connected) all.push(new AgentSessionItem(srv.token, s, this.icons));
    if (!all.length) {
      void vscode.window.showInformationMessage('TN5250: no agent session is connected.');
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      `TN5250: sign off and close ${all.length} agent session${all.length === 1 ? '' : 's'}? An agent that is working loses its session.`,
      { modal: true },
      'Sign Off and Close',
    );
    if (pick !== 'Sign Off and Close') return;
    let failed = 0;
    for (const item of all) {
      try {
        await endSession(item.token, item.session.session);
      } catch {
        failed++;
      }
    }
    void vscode.window.showInformationMessage(`TN5250: ${all.length - failed} agent session${all.length - failed === 1 ? '' : 's'} ended${failed ? `, ${failed} could not be ended (older tn5250-tui?)` : ''}.`);
    void this.poll();
  }

  /** Forget: removes one server's token file; it comes back only if that server registers again. */
  forget(item: AgentServerItem): void {
    forgetToken(item.token.path);
    void this.poll();
  }

  /** Clean Up: forgets every server that does not answer (servers whose process is gone are dropped on every poll). */
  cleanUp(): void {
    const dead = this.servers.filter((s) => !s.sessions);
    for (const s of dead) forgetToken(s.token.path);
    void vscode.window.showInformationMessage(dead.length ? `TN5250: ${dead.length} agent server${dead.length === 1 ? '' : 's'} forgotten.` : 'TN5250: every listed agent server answers; nothing to clean up.');
    void this.poll();
  }

  refresh(): void {
    void this.poll();
  }

  getTreeItem(element: AgentNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AgentNode): AgentNode[] {
    if (element instanceof AgentServerItem) return (element.sessions ?? []).map((s) => new AgentSessionItem(element.token, s, this.icons));
    if (element) return [];
    return this.servers;
  }

  /** Where Install tn5250-tui puts the console terminal: a folder of this extension's own. */
  installDir(): string {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'tn5250-tui').fsPath;
  }

  /** The console terminal: the setting, the copy installed here, PATH, the installer's folder. */
  findBinary(): string | undefined {
    const setting = vscode.workspace.getConfiguration('tn5250').get<string>('agent.binary', '');
    return findBinary(setting, undefined, undefined, undefined, [...(installedBinary(this.installDir(), process.platform) ? [dirname(installedBinary(this.installDir(), process.platform)!)] : [])]);
  }

  /**
   * Install tn5250-tui: the latest release for this platform, from GitHub, checked against the
   * release's SHA256SUMS, unpacked into the extension's storage. The binary is then found
   * without any PATH work; the setting may stay empty.
   */
  async install(): Promise<string | undefined> {
    const dir = this.installDir();
    try {
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'TN5250: installing tn5250-tui' }, async (progress) => {
        const deps = {
          fetch: (url: string, init?: { redirect?: 'follow' | 'manual' }) => fetch(url, init),
          extract: tarExtract,
          platform: process.platform,
          arch: process.arch,
          report: (text: string) => progress.report({ message: text }),
        };
        progress.report({ message: 'Looking up the latest release…' });
        const tag = await latestTag(deps);
        const bin = await installRelease(dir, tag, deps);
        void vscode.window.showInformationMessage(`TN5250: tn5250-tui ${tag} installed: ${bin}`);
        this.refresh();
        return bin;
      });
    } catch (e) {
      void vscode.window.showErrorMessage(`TN5250: could not install tn5250-tui: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** The binary, or an offer to install it. */
  private binary(): string | undefined {
    const bin = this.findBinary();
    if (!bin) {
      void vscode.window
        .showWarningMessage('TN5250: tn5250-tui (the console terminal) was not found. Install it here, or set tn5250.agent.binary.', 'Install tn5250-tui', 'Open Settings')
        .then((pick) => {
          if (pick === 'Install tn5250-tui') void this.install();
          else if (pick) void vscode.commands.executeCommand('workbench.action.openSettings', 'tn5250.agent.binary');
        });
    }
    return bin;
  }

  /**
   * Opens (or shows) the viewer of one session where asked. A new viewer is created in its
   * place (the terminal panel, or beside the active editor): nothing is moved, so the layout
   * the user arranged stays. keepFocus leaves the focus where it is (a viewer that opened by
   * itself must not take the keyboard).
   */
  async open(item: AgentSessionItem, where: Exclude<OpenViewer, 'off'>, keepFocus = false): Promise<vscode.Terminal | undefined> {
    const key = sessionKey(item.token.addr, item.session.session);
    let term = this.terminals.get(key);
    const created = !term;
    if (!term) {
      const bin = this.binary();
      if (!bin) return undefined;
      term = vscode.window.createTerminal({
        name: `Agent ${item.session.session} · ${item.session.host}`,
        shellPath: bin,
        shellArgs: attachArgs(item.token, item.session.session),
        iconPath: new vscode.ThemeIcon('eye'),
        isTransient: true,
        location: where === 'panel' ? vscode.TerminalLocation.Panel : { viewColumn: vscode.ViewColumn.Beside, preserveFocus: keepFocus },
      });
      this.terminals.set(key, term);
    }
    if (where === 'window') {
      // Moving into a window acts on the active terminal.
      term.show(false);
      await vscode.commands.executeCommand('workbench.action.terminal.moveIntoNewWindow');
    } else if (!created || where === 'panel') {
      term.show(keepFocus);
    }
    return term;
  }

  /** Opens (or shows) the terminal that watches one session, in the terminal panel. */
  watch(item: AgentSessionItem): Promise<vscode.Terminal | undefined> {
    return this.open(item, 'panel');
  }

  /** Watches the session in the editor area (a tab you can drag out) or in a window of its own. */
  async popOut(item: AgentSessionItem, where: 'editor' | 'window'): Promise<void> {
    await this.open(item, where);
  }

  /**
   * Enroll User for AI Agent: saves one of this extension's connections, with the user's
   * own sign-on, as the agent's site in the console terminal's sites file, bypass sign-on
   * on. For people who cannot get a separate user profile for their agent (contractors,
   * say). The password leaves the secret store for a clear-text file, so it asks first
   * and says where it goes.
   */
  async enroll(): Promise<void> {
    const sessions = resolvedSessions().filter((s) => s.host.trim());
    if (!sessions.length) {
      void vscode.window.showInformationMessage('TN5250: add a connection first (Sessions view, +); the agent enrolls with one of your connections.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessions.map((s, i) => ({ label: s.name || s.host, description: `${s.signonUser.trim().toUpperCase() || 'no user'}@${s.host}:${s.port}${s.tls ? ' TLS' : ''}`, i })),
      { title: 'TN5250: enroll which connection for the AI agent?', placeHolder: 'The agent signs on with this connection and your user profile' },
    );
    if (!pick) return;
    const session = sessions[pick.i]!;
    let user = session.signonUser.trim().toUpperCase();
    if (!user) {
      const typed = await vscode.window.showInputBox({ title: `TN5250: user profile the agent signs on with at ${session.host}`, prompt: 'The connection has no sign-on user.', ignoreFocusOut: true });
      if (!typed?.trim()) return;
      user = typed.trim().toUpperCase();
    }
    let password = await findPassword(this.context.secrets, session, user);
    if (!password) {
      password = await vscode.window.showInputBox({
        title: `TN5250: password of ${user} at ${session.host}`,
        prompt: 'Not in the VS Code secret store. It goes into the console terminal’s sites file only (not stored here).',
        password: true,
        ignoreFocusOut: true,
      });
      if (!password) return;
    }
    const cfg = vscode.workspace.getConfiguration('tn5250');
    const siteName = cfg.get<string>('agent.site', 'agent').trim() || 'agent';
    const path = sitesPath();
    const target = vscode.Uri.file(path);
    let existing: string | undefined;
    try {
      existing = Buffer.from(await vscode.workspace.fs.readFile(target)).toString('utf8');
    } catch {
      existing = undefined;
    }
    // An enrolled site is replaced, and the dialog says so: a second Enroll used to look
    // like it did nothing (the file changed, but nothing on screen said what had been there).
    const was = enrolledUser(existing, siteName);
    const replacing = !!was;
    const ok = await vscode.window.showWarningMessage(
      replacing ? `Replace the AI agent's enrollment ${was} with ${user}@${session.host}?` : `Enroll ${user}@${session.host} for the AI agent?`,
      {
        modal: true,
        detail:
          (replacing
            ? `Site "${siteName}" is enrolled as ${was}. Its host, user and password are replaced; a tn5250-tui MCP server that is already running keeps the old sign-on until it is restarted (in Claude Code: /mcp, reconnect tn5250).\n\n`
            : '') +
          `The agent signs on as ${user} with your password, with bypass sign-on turned on, and everything it does on the host is logged under your profile.\n\n` +
          `Your password is written to the console terminal's sites file:\n${path}\n(site "${siteName}"). The next start of tn5250-tui or its MCP server moves it from there into the OS secret store (Credential Manager, Keychain, Secret Service); until then the file holds it in clear text, readable by every program running as you.\n\n` +
          `Remove it any time with TN5250: Remove Agent Enrollment, or :sites in tn5250-tui.`,
      },
      replacing ? 'Replace' : 'Enroll',
    );
    if (ok !== (replacing ? 'Replace' : 'Enroll')) return;
    let text: string;
    try {
      text = enrollSite(existing, {
        name: siteName,
        host: session.host,
        port: session.port,
        tls: session.tls,
        trustAnyCertificate: !session.verifyCertificate,
        user,
        password,
        screenSize: session.screenSize,
        codePage: session.codePage,
        deviceName: '', // the host names the agent's workstation; the user's own name stays free
        autoSignon: true,
      });
    } catch (e) {
      void vscode.window.showErrorMessage(`TN5250: ${path} is not valid JSON (${(e as Error).message}); fix it or remove it first.`);
      return;
    }
    try {
      writePrivateFile(path, text);
    } catch (e) {
      void vscode.window.showErrorMessage(`TN5250: could not write ${path}: ${(e as Error).message}`);
      return;
    }
    // Read it back: the message reports what the file holds, not what was meant to be written.
    const now = enrolledUser(Buffer.from(await vscode.workspace.fs.readFile(target)).toString('utf8'), siteName);
    if (now.toUpperCase() !== `${user}@${session.host}`.toUpperCase()) {
      void vscode.window.showErrorMessage(`TN5250: ${path} shows site "${siteName}" as ${now || 'missing'} after the write; check the file.`);
      return;
    }
    const next = await vscode.window.showInformationMessage(
      `TN5250: ${user}@${session.host} enrolled as site "${siteName}" in ${path}${replacing ? ` (was ${was}; restart a running agent server for it to take effect)` : ''}.`,
      'Set Up Claude Code',
    );
    if (next) await this.setup();
  }

  /** Removes the agent's site (and the password in it) from the console terminal's sites file. */
  async unenroll(): Promise<void> {
    const siteName = vscode.workspace.getConfiguration('tn5250').get<string>('agent.site', 'agent').trim() || 'agent';
    const path = sitesPath();
    const target = vscode.Uri.file(path);
    let existing: string | undefined;
    try {
      existing = Buffer.from(await vscode.workspace.fs.readFile(target)).toString('utf8');
    } catch {
      existing = undefined;
    }
    let text: string | undefined;
    try {
      text = removeSite(existing, siteName);
    } catch (e) {
      void vscode.window.showErrorMessage(`TN5250: ${path} is not valid JSON (${(e as Error).message}).`);
      return;
    }
    if (text === undefined) {
      void vscode.window.showInformationMessage(`TN5250: no site "${siteName}" in ${path}; nothing to remove.`);
      return;
    }
    const who = enrolledUser(existing, siteName);
    const form = sitePasswordForm(existing, siteName);
    const keyring = form === 'keyring';
    const REMOVE = 'Remove';
    const choice = await vscode.window.showWarningMessage(
      `Remove the AI agent's enrollment ${who || `"${siteName}"`}?`,
      {
        modal: true,
        detail:
          `Site "${siteName}" (${who || 'unknown'}) is deleted from ${path}.\n\n` +
          (keyring
            ? `Its password is in the OS keyring (service tn5250-tui, account site:${siteName.toLowerCase()}). This command cannot delete that item: the extension has no keyring access and tn5250-tui has no command for it yet. To delete both, cancel and delete the site with :sites in tn5250-tui instead; otherwise remove the keyring item with your OS keyring tool.`
            : form === 'sealed'
              ? 'Its password is stored encrypted in that file and goes with the entry.'
              : form === 'clear'
                ? 'Its password is in clear text in that file and goes with the entry.'
                : 'It holds no password.'),
      },
      REMOVE,
    );
    if (choice !== REMOVE) return;
    try {
      writePrivateFile(path, text);
    } catch (e) {
      void vscode.window.showErrorMessage(`TN5250: could not write ${path}: ${(e as Error).message}`);
      return;
    }
    void vscode.window.showInformationMessage(
      `TN5250: site "${siteName}" removed from ${path}. A running agent server keeps its open sessions until it exits.` +
        (keyring ? ` Not removed: its password in the OS keyring (service tn5250-tui, account site:${siteName.toLowerCase()}); delete it with your keyring tool.` : ''),
    );
  }

  /** Writes (or merges) the Claude Code `.mcp.json` of the workspace. */
  async setup(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showInformationMessage('TN5250: open a folder first; .mcp.json goes into the workspace root.');
      return;
    }
    const cfg = vscode.workspace.getConfiguration('tn5250');
    const bin = this.findBinary() ?? 'tn5250-tui';
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
      `TN5250: ${target.fsPath} now starts tn5250-tui mcp for site "${site}"${readOnly ? ' (read-only)' : ''}; other arguments (such as --audit) and env of an existing entry were kept. Add that site in tn5250-tui (:sites) with the agent's own user profile, then restart Claude Code in this folder.`,
    );
    await vscode.window.showTextDocument(target);
  }
}
