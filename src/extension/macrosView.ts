import * as vscode from 'vscode';
import { describeStep, type Macro } from '../shared/macros';
import { macroStore } from './macros';

/** One macro in the Macros view: name, key and step count; play / pencil / trash inline. */
export class MacroItem extends vscode.TreeItem {
  constructor(readonly macro: Macro) {
    super(macro.name, vscode.TreeItemCollapsibleState.None);
    const steps = `${macro.steps.length} step${macro.steps.length === 1 ? '' : 's'}`;
    this.description = macro.key ? `${macro.key} · ${steps}` : steps;
    const preview = macro.steps.slice(0, 6).map(describeStep).join(' · ') + (macro.steps.length > 6 ? ' …' : '');
    this.tooltip = `${macro.name}\n${macro.key ? `Key: ${macro.key}\n` : ''}${steps}${preview ? `: ${preview}` : ''}\nPlay: run in the active tab · pencil: rename, key, steps · trash: delete`;
    this.iconPath = new vscode.ThemeIcon(macro.key ? 'keyboard' : 'symbol-event');
    this.contextValue = 'macro';
    this.id = `macro:${macro.id}`;
  }
}

/** The "Macros" tree in the TN5250 side bar: every saved macro, sorted by name. */
export class MacrosProvider implements vscode.TreeDataProvider<MacroItem> {
  private readonly changed = new vscode.EventEmitter<MacroItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private view: vscode.TreeView<MacroItem> | undefined;
  /** The row just acted on: it gets a fresh id on the next build, so VS Code drops its selection. */
  private bumped: string | undefined;
  private nonce = 0;

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(macroStore.onDidChange(() => this.refresh()));
  }

  attach(view: vscode.TreeView<MacroItem>): void {
    this.view = view;
    this.updateCount();
  }

  /** Drops the selection of a clicked row (a selected row keeps its inline actions visible). */
  deselect(item: vscode.TreeItem): void {
    this.bumped = item.id;
    this.nonce++;
    this.refresh();
  }

  refresh(): void {
    this.changed.fire(undefined);
    this.updateCount();
  }

  private updateCount(): void {
    if (!this.view) return;
    const n = macroStore.list().length;
    this.view.description = n ? `${n}` : undefined;
  }

  getTreeItem(element: MacroItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: MacroItem): MacroItem[] {
    if (element) return [];
    return macroStore
      .list()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map((m) => {
        const item = new MacroItem(m);
        if (this.bumped && item.id === this.bumped) item.id = `${item.id}#${this.nonce}`;
        return item;
      });
  }
}
