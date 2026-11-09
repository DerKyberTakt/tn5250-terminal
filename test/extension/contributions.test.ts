import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Command { command: string; title: string; icon?: string }
interface MenuEntry { command: string; when?: string; group?: string }
interface Pkg {
  contributes: {
    views: Record<string, Array<{ id: string; name: string }>>;
    viewsWelcome?: Array<{ view: string; contents: string }>;
    commands: Command[];
    menus: Record<string, MenuEntry[]>;
  };
}

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as Pkg;
const c = pkg.contributes;
const commands = new Map(c.commands.map((x) => [x.command, x]));
const viewIds = new Set(Object.values(c.views).flat().map((v) => v.id));

describe('package.json contributions', () => {
  it('has the Sessions, Macros and History views in that order', () => {
    expect(c.views.tn5250?.map((v) => v.name)).toEqual(['Sessions', 'Macros', 'History']);
  });

  it('every menu entry names a contributed command and a contributed view', () => {
    for (const [menu, entries] of Object.entries(c.menus)) {
      for (const e of entries) {
        expect(commands.has(e.command), `${menu}: ${e.command}`).toBe(true);
        const view = /view == ([\w.]+)/.exec(e.when ?? '')?.[1];
        if (view) expect(viewIds.has(view), `${menu}: ${e.when}`).toBe(true);
      }
    }
  });

  it('icon buttons (inline row actions, title bar navigation) have an icon', () => {
    const iconic = [...(c.menus['view/item/context'] ?? []), ...(c.menus['view/title'] ?? [])].filter((e) => /^(inline|navigation)/.test(e.group ?? ''));
    for (const e of iconic) expect(commands.get(e.command)?.icon, e.command).toMatch(/^\$\(.+\)$/);
  });

  it('the Macros view has play / pencil / trash on each row and New, Record, Import, Export on top', () => {
    const rows = (c.menus['view/item/context'] ?? []).filter((e) => e.when?.includes('tn5250.macrosView')).map((e) => commands.get(e.command)?.icon);
    expect(rows).toEqual(['$(play)', '$(edit)', '$(trash)']);
    const top = (c.menus['view/title'] ?? []).filter((e) => e.when?.includes('tn5250.macrosView') && e.group?.startsWith('navigation')).map((e) => e.command);
    expect(top).toEqual(['tn5250.newMacro', 'tn5250.recordMacro', 'tn5250.stopRecording', 'tn5250.importMacros', 'tn5250.exportMacros']);
    // Record and Stop Recording swap on the recording context key.
    const rec = (c.menus['view/title'] ?? []).find((e) => e.command === 'tn5250.recordMacro' && e.when?.includes('macrosView'));
    const stop = (c.menus['view/title'] ?? []).find((e) => e.command === 'tn5250.stopRecording');
    expect(rec?.when).toContain('!tn5250.recording');
    expect(stop?.when).toContain('&& tn5250.recording');
  });

  it('welcome links point at contributed commands', () => {
    for (const w of c.viewsWelcome ?? []) {
      expect(viewIds.has(w.view)).toBe(true);
      for (const m of w.contents.matchAll(/command:([\w.]+)/g)) expect(commands.has(m[1] as string), m[1]).toBe(true);
    }
    expect(c.viewsWelcome?.some((w) => w.view === 'tn5250.macrosView')).toBe(true);
  });

  it('row-only commands stay out of the Command Palette', () => {
    const hidden = new Set((c.menus.commandPalette ?? []).filter((e) => e.when === 'false').map((e) => e.command));
    for (const cmd of ['tn5250.runMacroItem', 'tn5250.editMacroItem', 'tn5250.deleteMacroItem']) expect(hidden.has(cmd), cmd).toBe(true);
  });
});
