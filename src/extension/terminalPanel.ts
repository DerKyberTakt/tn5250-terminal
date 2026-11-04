import * as os from 'node:os';
import * as vscode from 'vscode';
import { expandDeviceName } from '../shared/deviceName';
import type { PcCommandKind } from '../shared/pcCommand';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import { DEFAULT_OIA } from '../shared/protocol';
import { SETTINGS_DEFAULTS, buildTitle, type TerminalSettings } from '../shared/settings';
import { signonUser, type HistoryEntry } from '../shared/history';
import * as path from 'node:path';
import { buildDemoScreen } from '../engine/demoScreen';
import { HostConnection } from './connection';
import { runPcCommand } from './pcShell';
import { SessionController } from './sessionController';
import { readDefaults, readSessions, resolvedSessions, saveSession } from './settingsStore';
import { certPassphraseKey, findPassword } from './secrets';
import * as fsp from 'node:fs/promises';
import { buildWebviewHtml } from './webviewHtml';

interface PanelState {
  profile?: TerminalSettings;
}

function isProfile(value: unknown): value is TerminalSettings {
  const p = value as TerminalSettings;
  return typeof p === 'object' && p !== null && typeof p.host === 'string' && typeof p.port === 'number';
}

/** One 5250 terminal tab: a webview plus (optionally) a live session. */
export class TerminalPanel {
  static readonly viewType = 'tn5250.terminal';
  static active: TerminalPanel | undefined;
  static onActiveChanged: (() => void) | undefined;
  /** Told when a tab opens, closes, connects, disconnects or changes its title. */
  static readonly onDidChange = new Set<() => void>();
  /** Where connections are written for the History view (set by the extension). */
  static history: { record(entry: HistoryEntry): void } | undefined;
  /** The running history entry of this tab, between connect and disconnect. */
  private historyEntry: HistoryEntry | undefined;
  /** Why the next disconnect happens, when the tab itself causes it. */
  private endReason: HistoryEntry['endedBy'] | undefined;

  private static changed(): void {
    for (const f of TerminalPanel.onDidChange) {
      try {
        f();
      } catch {
        // one listener must not stop the others, or the tab that caused the change
      }
    }
  }

  private rows = 24;
  private cols = 80;
  private keyOverlay: boolean;
  private disposed = false;
  /** The tab title, kept here because the WebviewPanel refuses every read once it is disposed. */
  private titleText: string;
  private controller: SessionController | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  /** Tabs opened per device-name template, so * and = produce distinct names. */
  private static readonly deviceOrdinals = new Map<string, number>();
  /** Session letters in use (ACS: A, B, C ...). */
  private static readonly letters = new Set<string>();
  static readonly open = new Set<TerminalPanel>();

  /** Expands a workstation template with the next free ordinal for that template. */
  static expandDevice(template: string): string {
    const ordinal = TerminalPanel.deviceOrdinals.get(template) ?? 0;
    TerminalPanel.deviceOrdinals.set(template, ordinal + 1);
    let userName: string;
    try {
      userName = os.userInfo().username;
    } catch {
      userName = '';
    }
    return expandDeviceName(template, { computerName: os.hostname(), userName, ordinal });
  }

  private static nextLetter(): string {
    for (let i = 0; i < 26; i++) {
      const l = String.fromCharCode(65 + i);
      if (!TerminalPanel.letters.has(l)) {
        TerminalPanel.letters.add(l);
        return l;
      }
    }
    return String(TerminalPanel.letters.size + 1);
  }

  static create(context: vscode.ExtensionContext, output: vscode.OutputChannel, profile?: TerminalSettings): TerminalPanel {
    let deviceTemplate = '';
    if (profile?.deviceName.trim()) {
      deviceTemplate = profile.deviceName.trim();
      profile = { ...profile, deviceName: TerminalPanel.expandDevice(deviceTemplate) };
    }
    const letter = profile ? TerminalPanel.nextLetter() : '';
    const panel = vscode.window.createWebviewPanel(
      TerminalPanel.viewType,
      profile ? buildTitle(profile, letter) : 'TN5250',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: profile ? !profile.switchToNewTab : false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(context.globalStorageUri, 'fonts')],
      },
    );
    return new TerminalPanel(context, output, panel, profile, letter, deviceTemplate);
  }

  static restore(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    panel: vscode.WebviewPanel,
    state: unknown,
  ): TerminalPanel {
    const profile = (state as PanelState | undefined)?.profile;
    const p = isProfile(profile) ? { ...SETTINGS_DEFAULTS, ...profile } : undefined;
    return new TerminalPanel(context, output, panel, p, p ? TerminalPanel.nextLetter() : '', '');
  }

  private static setActive(panel: TerminalPanel | undefined): void {
    TerminalPanel.active = panel;
    if (panel) panel.activatedAt = Date.now();
    TerminalPanel.onActiveChanged?.();
    TerminalPanel.changed();
  }

  /** When this tab was last shown (the side bar reveals a session's most recent tab). */
  activatedAt = 0;

  /** Brings the tab to the front. */
  reveal(): void {
    this.panel.reveal();
  }

  /** Closes the tab (same as closing it from its editor tab). */
  close(): void {
    this.panel.dispose();
  }

  private constructor(
    context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly panel: vscode.WebviewPanel,
    readonly profile: TerminalSettings | undefined,
    private readonly letter: string,
    private template: string,
  ) {
    this.titleText = panel.title;
    TerminalPanel.open.add(this);
    queueMicrotask(() => TerminalPanel.changed());
    this.keyOverlay = vscode.workspace.getConfiguration('tn5250').get<boolean>('debug.keyOverlay', false);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(context.globalStorageUri, 'fonts')],
    };
    panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri);

    if (profile) {
      this.rows = profile.screenSize === '27x132' ? 27 : 24;
      this.cols = profile.screenSize === '27x132' ? 132 : 80;
      const label = profile.name || profile.host;
      this.controller = new SessionController(profile, {
        screen: (screen, oia) => {
          this.post({ type: 'screen', screen });
          this.post({ type: 'oia', oia });
        },
        status: (status, detail, info) => {
          this.post({ type: 'status', status, detail, info });
          this.output.appendLine(`[${label}] ${status}: ${detail}`);
          // The host may have refused the workstation name and the next one was tried: the
          // tab title shows the name the host accepted.
          if (status === 'connected') this.refreshTitle();
          TerminalPanel.onActiveChanged?.();
          TerminalPanel.changed();
          this.recordHistory(status, detail, info.manual === true);
        },
        alarm: () => this.post({ type: 'alarm' }),
        clientAuth: async () => {
          if (profile.tlsClientAuth === 'none' || !profile.tlsClientCert) return undefined;
          const passphrase = (await context.secrets.get(certPassphraseKey(profile.name, profile.host))) ?? (await context.secrets.get(certPassphraseKey('', profile.host)));
          try {
            if (profile.tlsClientAuth === 'pfx') return { pfx: await fsp.readFile(profile.tlsClientCert), passphrase };
            return { cert: await fsp.readFile(profile.tlsClientCert), key: profile.tlsClientKey ? await fsp.readFile(profile.tlsClientKey) : undefined, passphrase };
          } catch (err) {
            this.output.appendLine(`client certificate not readable: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
          }
        },
        nextDeviceName: () => (this.template && /[*=]/.test(this.template) ? TerminalPanel.expandDevice(this.template) : undefined),
        password: async () => {
          const user = (resolvedSessions().find((s) => s.name === profile.name && s.host === profile.host) ?? profile).signonUser;
          return findPassword(context.secrets, profile, user);
        },
        certificateRejected: (fingerprint, reason) => void this.offerTrust(fingerprint, reason),
        signon: () => resolvedSessions().find((s) => s.name === profile.name && s.host === profile.host) ?? profile,
        log: (message) => this.output.appendLine(`[${label}] ${message}`),
        pcCommandPolicy: () => this.liveSettings().pcCommands,
        pcCommand: (kind, decision, wait) => this.handlePcCommand(kind, decision, wait),
      }, (events) => new HostConnection(events));
    }

    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg)),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) TerminalPanel.setActive(this);
        else if (TerminalPanel.active === this) TerminalPanel.setActive(undefined);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tn5250')) {
          this.keyOverlay = vscode.workspace.getConfiguration('tn5250').get<boolean>('debug.keyOverlay', false);
          this.pushConfig();
        }
      }),
      panel.onDidDispose(() => this.dispose()),
    );
    context.subscriptions.push(panel);
    if (panel.active) TerminalPanel.setActive(this);
  }

  get title(): string {
    return this.titleText;
  }

  /** The id of this tab's running history entry, for the heartbeat that marks it alive. */
  get historyId(): string | undefined {
    return this.historyEntry?.id;
  }

  get sessionLetter(): string {
    return this.letter;
  }

  private refreshTitle(): void {
    if (!this.profile) return;
    const title = buildTitle(this.liveSettings(), this.letter);
    if (title === this.titleText) return;
    this.titleText = title;
    this.panel.title = title;
    TerminalPanel.changed();
  }

  /** The profile's connection values with the live appearance/behavior settings. */
  private liveSettings(): TerminalSettings {
    let settings = readDefaults();
    if (this.profile) {
      const saved = resolvedSessions().find((s) => s.name === this.profile?.name && s.host === this.profile?.host);
      const live = saved ?? settings;
      settings = { ...live, host: this.profile.host, port: this.profile.port, tls: this.profile.tls, name: this.profile.name,
        screenSize: this.profile.screenSize, codePage: this.profile.codePage, deviceName: this.profile.deviceName };
    }
    return settings;
  }

  get connected(): boolean {
    return !this.disposed && (this.controller?.connected ?? false);
  }

  connect(): void {
    void this.controller?.connect();
  }

  disconnect(): void {
    this.controller?.disconnect();
  }

  /** The Workstation ID template this tab was opened with ('' = assigned by the host). */
  get deviceTemplate(): string {
    return this.template;
  }

  /** Opens a history entry on connect, closes it on disconnect (device name as finally accepted). */
  private recordHistory(status: string, detail: string, manual: boolean): void {
    const p = this.profile;
    if (!p || !TerminalPanel.history) return;
    if (status === 'connected') {
      if (this.historyEntry && !this.historyEntry.end) {
        // Connected again without a disconnect in between: the host refused the workstation
        // name and the next one was tried. Same connection, same entry, new device name.
        this.historyEntry = { ...this.historyEntry, deviceName: p.deviceName, tabTitle: this.title };
        TerminalPanel.history.record(this.historyEntry);
        return;
      }
      const saved = resolvedSessions().some((s) => s.name === p.name && s.host === p.host);
      this.historyEntry = {
        id: `${Date.now().toString(36)}-${this.letter}`,
        sessionName: saved ? p.name : '',
        host: p.host,
        port: p.port,
        tls: p.tls,
        screenSize: p.screenSize,
        deviceName: p.deviceName,
        user: p.autoSignon ? p.signonUser.trim().toUpperCase() : '',
        tabTitle: this.title,
        start: Date.now(),
      };
      TerminalPanel.history.record(this.historyEntry);
    } else if (status === 'disconnected' && this.historyEntry && !this.historyEntry.end) {
      const endedBy = this.endReason ?? (manual ? 'user' : /closed by host/i.test(detail) ? 'host' : 'error');
      this.endReason = undefined;
      this.historyEntry = { ...this.historyEntry, deviceName: p.deviceName, tabTitle: this.title, end: Date.now(), endedBy };
      TerminalPanel.history.record(this.historyEntry);
      this.historyEntry = undefined;
    }
  }

  /** Enter on the sign-on screen: remember the user profile for the history entry. */
  private noteSignon(): void {
    if (!this.historyEntry || this.historyEntry.user || !this.controller || !TerminalPanel.history) return;
    const user = signonUser(this.controller.screenText());
    if (!user) return;
    this.historyEntry = { ...this.historyEntry, user };
    TerminalPanel.history.record(this.historyEntry);
  }

  /**
   * Connection settings saved while the tab is open (Save & Reload): the tab takes the new
   * values and reconnects. The controller shares the profile object, so assigning onto it is
   * enough; the workstation name is expanded again only when its template changed.
   */
  reload(profile: TerminalSettings): void {
    if (!this.profile || !this.controller) return;
    const template = profile.deviceName.trim();
    const deviceName = template === this.template ? this.profile.deviceName : template ? TerminalPanel.expandDevice(template) : '';
    this.template = template;
    Object.assign(this.profile, { ...profile, deviceName });
    this.rows = this.profile.screenSize === '27x132' ? 27 : 24;
    this.cols = this.profile.screenSize === '27x132' ? 132 : 80;
    this.endReason = 'reload';
    this.disconnect();
    this.refreshTitle();
    this.pushConfig();
    this.connect();
  }

  screenText(): string | undefined {
    return this.controller?.screenText();
  }

  exportTrace(): Record<string, unknown> | undefined {
    return this.controller?.exportTrace();
  }

  /**
   * The host certificate was refused: offer to pin its fingerprint on this session
   * ("trust this certificate"), then connect again. Unsaved (ad-hoc) sessions get the
   * pin for this tab only.
   */
  private async offerTrust(fingerprint: string, reason: string): Promise<void> {
    if (!this.profile || !this.controller) return;
    const pretty = fingerprint.replace(/[^0-9a-f]/gi, '').toUpperCase().replace(/(..)(?=.)/g, '$1:');
    const choice = await vscode.window.showWarningMessage(
      `TN5250: the certificate of ${this.profile.host} was not accepted: ${reason}.

SHA-256 fingerprint:
${pretty}

Trust it only if this fingerprint matches what the system administrator shows for this host.`,
      { modal: true },
      'Trust this certificate',
    );
    if (choice !== 'Trust this certificate') return;
    this.profile.tlsPinnedCertificate = fingerprint;
    const index = readSessions().findIndex((s) => s.name === this.profile!.name && s.host === this.profile!.host);
    if (index >= 0) {
      const saved = resolvedSessions()[index];
      if (saved) await saveSession(index, { ...saved, tlsPinnedCertificate: fingerprint });
    }
    this.output.appendLine(`[${this.profile.name || this.profile.host}] certificate ${pretty} trusted for this session`);
    this.controller.reconnectNow();
  }

  /** Demo screen only (no session): flips between 24x80 and 27x132. */
  toggleScreenSize(): void {
    if (this.controller) return;
    if (this.cols === 80) {
      this.rows = 27;
      this.cols = 132;
    } else {
      this.rows = 24;
      this.cols = 80;
    }
    this.pushDemoScreen();
  }

  toggleKeyOverlay(): void {
    this.keyOverlay = !this.keyOverlay;
    this.pushConfig();
  }

  /** Session events (status on disconnect, async config loads) can arrive after the tab closed. */
  private post(message: HostToWebview): void {
    if (this.disposed) return;
    try {
      void this.panel.webview.postMessage(message).then(undefined, () => undefined);
    } catch {
      // The webview went away between the check and the call.
    }
  }

  /** Appearance and keyboard follow the live settings; connection values stay as the tab was opened. */
  private pushConfig(): void {
    const settings = this.liveSettings();
    this.refreshTitle();
    void this.loadWatermark(settings).then((watermarkImageData) => {
      const fontFace = settings.fontFile && settings.fontFamily
        ? { family: settings.fontFamily, url: this.panel.webview.asWebviewUri(vscode.Uri.file(settings.fontFile)).toString() }
        : undefined;
      this.post({ type: 'config', config: { settings, keyOverlay: this.keyOverlay, host: 'vscode', watermarkImageData, fontFace } });
    });
  }

  private async loadWatermark(settings: TerminalSettings): Promise<string | undefined> {
    const file = settings.watermarkImage.trim();
    if (settings.watermarkType !== 'image' || !file) return undefined;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
      const ext = path.extname(file).toLowerCase().replace('.', '');
      const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : `image/${ext || 'png'}`;
      return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
    } catch (err) {
      this.output.appendLine(`watermark image not readable: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private pushDemoScreen(): void {
    this.post({ type: 'screen', screen: buildDemoScreen(this.rows, this.cols) });
    this.post({ type: 'oia', oia: { ...DEFAULT_OIA, message: `${this.rows}x${this.cols}` } });
  }

  /** STRPCCMD from the host: open the link or run the command, asking first when the policy says so. */
  private async handlePcCommand(kind: PcCommandKind, decision: 'open' | 'run' | 'ask', wait: boolean): Promise<void> {
    const label = this.titleText;
    if (kind.kind === 'link') {
      if (decision === 'ask') {
        const pick = await vscode.window.showInformationMessage(`${label}: the host wants to open a link.\n\n${kind.url}`, { modal: true }, 'Open');
        if (pick !== 'Open') return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(kind.url));
      vscode.window.setStatusBarMessage(`TN5250: opened ${kind.url}`, 6000);
      return;
    }
    if (decision === 'ask') {
      const pick = await vscode.window.showWarningMessage(`${label}: the host wants to run this command on your PC.\n\n${kind.command}`, { modal: true }, 'Run');
      if (pick !== 'Run') {
        this.output.appendLine(`[${label}] PC command not run: ${kind.command}`);
        return;
      }
    }
    await runPcCommand(kind.command, wait);
  }

  private onMessage(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'ready':
        this.pushConfig();
        if (this.controller) {
          this.controller.publish();
          if (this.profile?.autoConnect !== false) void this.controller.connect();
        } else {
          this.pushDemoScreen();
        }
        break;
      case 'action':
        if (msg.action === 'enter') this.noteSignon();
        this.controller?.press(msg.action);
        break;
      case 'text':
        this.controller?.type(msg.text);
        break;
      case 'click':
        this.controller?.setCursor(msg.row, msg.col);
        break;
      case 'scroll':
        this.controller?.scrollBar(msg.addr, msg.forward, msg.increment);
        break;
      case 'mouse':
        this.controller?.mouseEvent(msg.event, msg.row, msg.col);
        break;
      case 'copy':
        void vscode.env.clipboard.writeText(msg.text);
        break;
      case 'reconnect':
        this.controller?.reconnectNow();
        break;
      case 'cancelReconnect':
        this.controller?.disconnect();
        break;
      case 'paste':
        void vscode.env.clipboard.readText().then((text) => this.post({ type: 'paste', text }));
        break;
      case 'printScreen':
        void vscode.commands.executeCommand('tn5250.printScreen');
        break;
      case 'openUrl':
        if (/^https?:\/\//i.test(msg.url)) void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case 'key':
        if (this.keyOverlay) {
          const m = msg.event;
          const mods = [m.ctrl && 'Ctrl', m.shift && 'Shift', m.alt && 'Alt', m.meta && 'Meta'].filter(Boolean).join('+');
          this.output.appendLine(`key ${mods ? mods + '+' : ''}${m.key} (${m.code})`);
        }
        break;
      case 'log':
        this.output.appendLine(msg.message);
        break;
    }
  }

  /**
   * The editor tab is gone (closed by the user, or VS Code shut the window). The WebviewPanel
   * is already disposed here, so nothing below may read it; and the bookkeeping must run
   * whatever else fails, or the tab stays listed as open and its connection stays up.
   */
  private dispose(): void {
    this.disposed = true;
    TerminalPanel.open.delete(this);
    TerminalPanel.letters.delete(this.letter);
    try {
      if (this.historyEntry && !this.historyEntry.end) {
        this.endReason = 'closed';
        this.recordHistory('disconnected', 'tab closed', false);
      }
    } catch (err) {
      this.output.appendLine(`history not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      this.controller?.dispose();
    } catch (err) {
      this.output.appendLine(`connection not closed cleanly: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const d of this.disposables.splice(0)) d.dispose();
    if (TerminalPanel.active === this) TerminalPanel.setActive(undefined);
    TerminalPanel.changed();
  }
}
