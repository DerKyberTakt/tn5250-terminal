import * as vscode from 'vscode';
import { EDITOR_ACTIONS, MacroRecorder, actionName, describeStep, macroProblems, newMacroId, runMacro, sanitizeMacro, type Macro, type MacroStep, type MacroTarget } from '../shared/macros';
import type { KeyAction } from '../shared/keymap';

/**
 * Macros in VS Code: recorded in a terminal tab (TN5250: Record Macro), kept in the
 * extension's global state, run from the Command Palette, the Macros list or their key.
 * The model, recorder and player are shared with the desktop app (src/shared/macros.ts);
 * the desktop app has the step editor, here a macro is recorded and then named, given a
 * key, renamed or deleted, and its steps are edited with lists and input boxes.
 */

const STATE_KEY = 'tn5250.macros';

/** What a running macro needs from the terminal tab it plays into. */
export interface MacroSession {
  readonly title: string;
  type(text: string): void;
  press(action: KeyAction): void;
  inputAllowed(): boolean;
  screenText(): string;
}

class MacroStore {
  private context: vscode.ExtensionContext | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  init(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  list(): Macro[] {
    const raw = this.context?.globalState.get<unknown[]>(STATE_KEY);
    return Array.isArray(raw) ? raw.map(sanitizeMacro).filter((m): m is Macro => !!m) : [];
  }

  /** The keys bound to macros, for the terminal page to catch. */
  keys(): string[] {
    return this.list().map((m) => m.key).filter(Boolean);
  }

  byKey(key: string): Macro | undefined {
    return this.list().find((m) => m.key === key);
  }

  async save(macro: Macro): Promise<void> {
    const list = this.list();
    const at = list.findIndex((m) => m.id === macro.id);
    if (at >= 0) list[at] = macro;
    else list.push(macro);
    await this.context?.globalState.update(STATE_KEY, list);
    this.changed.fire();
  }

  async remove(id: string): Promise<void> {
    await this.context?.globalState.update(STATE_KEY, this.list().filter((m) => m.id !== id));
    this.changed.fire();
  }
}

export const macroStore = new MacroStore();

let running: { macro: Macro; stop: AbortController; status: vscode.StatusBarItem } | undefined;

/** Plays a macro into a session, with a status bar item that stops it. */
export async function playMacro(macro: Macro, session: MacroSession, output: vscode.OutputChannel): Promise<void> {
  if (running) {
    void vscode.window.showWarningMessage(`TN5250: macro "${running.macro.name}" is still running.`, 'Stop it').then((pick) => {
      if (pick) running?.stop.abort();
    });
    return;
  }
  const stop = new AbortController();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.text = `$(debug-stop) Macro: ${macro.name}`;
  status.tooltip = 'Click to stop the macro';
  status.command = 'tn5250.stopMacro';
  status.show();
  running = { macro, stop, status };
  output.appendLine(`macro "${macro.name}" started in ${session.title}`);
  const target: MacroTarget = {
    type: (text) => session.type(text),
    press: (action) => session.press(action),
    inputAllowed: () => session.inputAllowed(),
    screenText: () => session.screenText(),
    prompt: (label, secret) => Promise.resolve(vscode.window.showInputBox({ title: `Macro "${macro.name}"`, prompt: label || 'Value', password: secret, ignoreFocusOut: true })),
  };
  try {
    const r = await runMacro(macro, target, { signal: stop.signal });
    if (r.ok) output.appendLine(`macro "${macro.name}" done`);
    else {
      const step = macro.steps[r.step];
      const text = `TN5250: macro "${macro.name}" stopped at step ${r.step + 1}${step ? ` (${describeStep(step)})` : ''}: ${r.reason}`;
      output.appendLine(text);
      if (r.reason !== 'stopped' && r.reason !== 'cancelled') void vscode.window.showWarningMessage(text);
    }
  } finally {
    status.dispose();
    running = undefined;
  }
}

export function stopMacro(): void {
  running?.stop.abort();
}

/** The macro bound to a key the terminal page reported, played into that session. */
export function runMacroKey(key: string, session: MacroSession, output: vscode.OutputChannel): boolean {
  const macro = macroStore.byKey(key);
  if (!macro) return false;
  void playMacro(macro, session, output);
  return true;
}

const KEY_RULE = /^(?:(?:Ctrl|Alt|Meta|Shift)\+)*(?:F\d{1,2}|[^\s+]+)$/;

function validateKey(value: string, others: Macro[], self: Macro): string | undefined {
  const key = value.trim();
  if (!key) return undefined;
  if (!KEY_RULE.test(key)) return 'Modifiers then the key, as "Ctrl+Alt+1", "Alt+F5" or "F24".';
  if (!/^(?:Ctrl|Alt|Meta)\+/.test(key) && !/^(?:Shift\+)?F\d{1,2}$/.test(key)) return 'Use a function key, or a combination with Ctrl, Alt or Meta, so typing is not affected.';
  // A character key carries its shift state in the character: Shift+1 arrives as "!".
  if (/Shift\+[^+]$/.test(key)) return 'With Shift, name the character the key produces instead: "Ctrl+!" for Ctrl+Shift+1.';
  const taken = others.find((o) => o.id !== self.id && o.key === key);
  return taken ? `${key} already runs "${taken.name}".` : undefined;
}

/** Normalises a typed key to the keyName() form: modifiers in the Ctrl, Alt, Meta, Shift order, a single character upper-cased. */
export function normalizeKey(value: string): string {
  const parts = value.trim().split('+').filter(Boolean);
  if (!parts.length) return '';
  const base = parts.pop() as string;
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const ordered = [mods.has('ctrl') && 'Ctrl', mods.has('alt') && 'Alt', mods.has('meta') && 'Meta', mods.has('shift') && 'Shift'].filter((m): m is string => !!m);
  const key = base.length === 1 ? base.toUpperCase() : /^f\d{1,2}$/i.test(base) ? base.toUpperCase() : base;
  return [...ordered, key].join('+');
}

async function askName(macro: Macro): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({ title: 'TN5250: Macro name', prompt: 'What the macro does', value: macro.name, ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : 'The macro needs a name.') });
  return name?.trim();
}

async function askKey(macro: Macro): Promise<string | undefined> {
  const others = macroStore.list();
  const value = await vscode.window.showInputBox({
    title: 'TN5250: Macro key',
    prompt: 'The key that runs it, as "Ctrl+Alt+1", "Alt+F5" or "Ctrl+Shift+F5"; empty for none. It wins over the keyboard map.',
    value: macro.key,
    ignoreFocusOut: true,
    validateInput: (v) => validateKey(normalizeKey(v), others, macro),
  });
  return value === undefined ? undefined : normalizeKey(value);
}

/** Names a freshly recorded macro, asks for its key, saves it. */
export async function saveRecordedMacro(recorder: MacroRecorder): Promise<Macro | undefined> {
  const steps = recorder.finish();
  if (!steps.length) {
    void vscode.window.showInformationMessage('TN5250: nothing was recorded.');
    return undefined;
  }
  const macro: Macro = { id: newMacroId(), name: '', key: '', steps };
  const name = await askName(macro);
  if (!name) return undefined;
  macro.name = name;
  const key = await askKey(macro);
  if (key === undefined) return undefined;
  macro.key = key;
  const problems = macroProblems(macro, macroStore.list());
  if (problems.length) {
    void vscode.window.showWarningMessage(`TN5250: ${problems.join(' ')}`);
    return undefined;
  }
  await macroStore.save(macro);
  void vscode.window.showInformationMessage(`TN5250: macro "${macro.name}" saved${macro.key ? ` (${macro.key})` : ''}.`);
  return macro;
}

/** Asks for the fields of a step; undefined when the user backs out. */
async function askStep(kind: MacroStep['type'], current?: MacroStep): Promise<MacroStep | undefined> {
  const text = async (prompt: string, value: string): Promise<string | undefined> =>
    vscode.window.showInputBox({ title: 'TN5250: Macro step', prompt, value, ignoreFocusOut: true, validateInput: (v) => (v ? undefined : 'Cannot be empty.') });
  const number = async (prompt: string, value: number): Promise<number | undefined> => {
    const v = await vscode.window.showInputBox({ title: 'TN5250: Macro step', prompt, value: String(value), ignoreFocusOut: true, validateInput: (x) => (/^\d+$/.test(x.trim()) ? undefined : 'A whole number of milliseconds.') });
    return v === undefined ? undefined : Number(v.trim());
  };
  switch (kind) {
    case 'text': {
      const t = await text('Text to type', current?.type === 'text' ? current.text : '');
      return t === undefined ? undefined : { type: 'text', text: t };
    }
    case 'key': {
      const pick = await vscode.window.showQuickPick(
        EDITOR_ACTIONS.map((a) => ({ label: actionName(a), action: a, picked: current?.type === 'key' && current.action === a })),
        { title: 'TN5250: Macro step', placeHolder: 'The key to press' },
      );
      return pick ? { type: 'key', action: pick.action } : undefined;
    }
    case 'wait': {
      const ms = await number('How long to wait, in milliseconds', current?.type === 'wait' ? current.ms : 500);
      return ms === undefined ? undefined : { type: 'wait', ms };
    }
    case 'waitInput':
      return { type: 'waitInput' };
    case 'waitText': {
      const t = await text('Text that must appear on the screen', current?.type === 'waitText' ? current.text : '');
      if (t === undefined) return undefined;
      const ms = await number('How long to wait for it, in milliseconds (0 = the default, 20 s)', current?.type === 'waitText' ? (current.timeoutMs ?? 0) : 0);
      if (ms === undefined) return undefined;
      return ms > 0 ? { type: 'waitText', text: t, timeoutMs: ms } : { type: 'waitText', text: t };
    }
    case 'prompt': {
      const label = await vscode.window.showInputBox({ title: 'TN5250: Macro step', prompt: 'What to ask for (shown as the prompt)', value: current?.type === 'prompt' ? current.label : '', ignoreFocusOut: true });
      if (label === undefined) return undefined;
      const hidden = await vscode.window.showQuickPick([{ label: 'Hide what is typed (a password)', secret: true }, { label: 'Show it', secret: false }], { title: 'TN5250: Macro step', placeHolder: 'How to take the answer' });
      if (!hidden) return undefined;
      return hidden.secret ? { type: 'prompt', label, secret: true } : { type: 'prompt', label };
    }
  }
}

const STEP_KINDS: Array<{ label: string; stepType: MacroStep['type'] }> = [
  { label: '$(symbol-text) Type text', stepType: 'text' },
  { label: '$(keyboard) Press a key', stepType: 'key' },
  { label: '$(watch) Wait for the host to accept input', stepType: 'waitInput' },
  { label: '$(clock) Wait (milliseconds)', stepType: 'wait' },
  { label: '$(eye) Wait for a text on the screen', stepType: 'waitText' },
  { label: '$(question) Ask for a value and type it', stepType: 'prompt' },
];

async function pickKind(): Promise<MacroStep['type'] | undefined> {
  const pick = await vscode.window.showQuickPick(STEP_KINDS, { title: 'TN5250: Add a step', placeHolder: 'What the step does' });
  return pick?.stepType;
}

/** Edits the steps of a macro with lists and input boxes (the desktop app has a graphical editor). */
async function editSteps(original: Macro): Promise<void> {
  const macro: Macro = { ...original, steps: original.steps.map((s) => ({ ...s })) };
  for (;;) {
    const rows = macro.steps.map((s, i) => ({ label: `${i + 1}. ${describeStep(s)}`, index: i }));
    const pick = await vscode.window.showQuickPick(
      [{ label: '$(add) Add a step at the end', index: -1 }, { label: '$(save) Save', index: -2 }, ...rows],
      { title: `TN5250: steps of "${macro.name}"`, placeHolder: 'Pick a step to change it, or add one' },
    );
    if (!pick) return;
    if (pick.index === -2) {
      await macroStore.save(macro);
      void vscode.window.showInformationMessage(`TN5250: macro "${macro.name}" saved (${macro.steps.length} step${macro.steps.length === 1 ? '' : 's'}).`);
      return;
    }
    if (pick.index === -1) {
      const kind = await pickKind();
      if (!kind) continue;
      const step = await askStep(kind);
      if (step) macro.steps.push(step);
      continue;
    }
    const i = pick.index;
    const step = macro.steps[i] as MacroStep;
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(edit) Change', action: 'edit' },
        { label: '$(arrow-up) Move up', action: 'up' },
        { label: '$(arrow-down) Move down', action: 'down' },
        { label: '$(insert) Insert a step after this one', action: 'insert' },
        { label: '$(trash) Remove', action: 'remove' },
      ],
      { title: `TN5250: step ${i + 1}: ${describeStep(step)}` },
    );
    if (!action) continue;
    switch (action.action) {
      case 'edit': {
        const edited = await askStep(step.type, step);
        if (edited) macro.steps[i] = edited;
        break;
      }
      case 'up':
        if (i > 0) macro.steps.splice(i - 1, 2, step, macro.steps[i - 1] as MacroStep);
        break;
      case 'down':
        if (i < macro.steps.length - 1) macro.steps.splice(i, 2, macro.steps[i + 1] as MacroStep, step);
        break;
      case 'insert': {
        const kind = await pickKind();
        if (!kind) break;
        const added = await askStep(kind);
        if (added) macro.steps.splice(i + 1, 0, added);
        break;
      }
      case 'remove':
        macro.steps.splice(i, 1);
        break;
    }
  }
}

function macroItem(m: Macro): vscode.QuickPickItem & { macro: Macro } {
  return { label: m.name, description: m.key ? `$(keyboard) ${m.key}` : undefined, detail: `${m.steps.length} step${m.steps.length === 1 ? '' : 's'}: ${m.steps.slice(0, 4).map(describeStep).join(' · ')}${m.steps.length > 4 ? ' …' : ''}`, macro: m };
}

/** TN5250: Run Macro. */
export async function pickAndRun(session: MacroSession | undefined, output: vscode.OutputChannel): Promise<void> {
  if (!session) {
    void vscode.window.showInformationMessage('TN5250: open a terminal tab first.');
    return;
  }
  const macros = macroStore.list();
  if (!macros.length) {
    void vscode.window.showInformationMessage('TN5250: no macros yet. Record one with TN5250: Record Macro.');
    return;
  }
  const pick = await vscode.window.showQuickPick(macros.map(macroItem), { title: 'TN5250: Run Macro', placeHolder: `Runs in ${session.title}`, matchOnDescription: true });
  if (pick) void playMacro(pick.macro, session, output);
}

/** TN5250: Macros: the list, with run, rename, key, steps and delete. */
export async function manageMacros(session: MacroSession | undefined, output: vscode.OutputChannel, startRecording: () => void): Promise<void> {
  for (;;) {
    const macros = macroStore.list();
    const record = { label: '$(record) Record a new macro…', detail: session ? `In ${session.title}: what you type and press until TN5250: Stop Recording` : 'Open a terminal tab first', macro: undefined as Macro | undefined };
    const blank = { label: '$(add) New empty macro…', detail: 'Name it, then add steps one by one', macro: undefined as Macro | undefined, blank: true };
    const pick = await vscode.window.showQuickPick([record, blank, ...macros.map(macroItem)], { title: 'TN5250: Macros', placeHolder: macros.length ? 'Pick a macro' : 'No macros yet', matchOnDescription: true });
    if (!pick) return;
    if (!pick.macro) {
      if ('blank' in pick) {
        const fresh: Macro = { id: newMacroId(), name: '', key: '', steps: [] };
        const name = await askName(fresh);
        if (!name) continue;
        fresh.name = name;
        await editSteps(fresh);
        continue;
      }
      if (session) startRecording();
      return;
    }
    const m = pick.macro;
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(play) Run', action: 'run', description: session ? `in ${session.title}` : 'open a terminal tab first' },
        { label: '$(edit) Rename', action: 'rename' },
        { label: '$(keyboard) Change key', action: 'key', description: m.key || 'none' },
        { label: '$(list-ordered) Edit steps', action: 'steps' },
        { label: '$(trash) Delete', action: 'delete' },
      ],
      { title: `TN5250: Macro "${m.name}"` },
    );
    if (!action) continue;
    switch (action.action) {
      case 'run':
        if (session) void playMacro(m, session, output);
        return;
      case 'rename': {
        const name = await askName(m);
        if (name) await macroStore.save({ ...m, name });
        break;
      }
      case 'key': {
        const key = await askKey(m);
        if (key !== undefined) await macroStore.save({ ...m, key });
        break;
      }
      case 'steps':
        await editSteps(m);
        break;
      case 'delete':
        if ((await vscode.window.showWarningMessage(`Delete macro "${m.name}"?`, { modal: true }, 'Delete')) === 'Delete') await macroStore.remove(m.id);
        break;
    }
  }
}
