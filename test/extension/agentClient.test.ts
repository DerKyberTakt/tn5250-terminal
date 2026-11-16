import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachArgs, enrollSite, enrolledUser, fetchSessions, findBinary, listTokens, mcpHasServer, mergeMcpJson, removeSite, sitesPath, tokenDir } from '../../src/extension/agentClient';

/** A fake `tn5250-tui mcp` viewer listener: hello with the token, then list. */
function fakeServer(token: string): Promise<{ server: Server; addr: string }> {
  return new Promise((resolve) => {
    const server = createServer((sock) => {
      let buf = '';
      let ok = false;
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const m = JSON.parse(buf.slice(0, nl)) as { t: string; token?: string };
          buf = buf.slice(nl + 1);
          if (m.t === 'hello') {
            if (m.token !== token) {
              sock.write(JSON.stringify({ t: 'error', text: 'bad token' }) + '\n');
              sock.end();
              return;
            }
            ok = true;
            sock.write(JSON.stringify({ t: 'sessions', sessions: [{ session: 's1', host: 'PUB400.COM', device: 'QPADEV0001', connected: true, seq: 7, inhibited: 'none' }] }) + '\n');
          } else if (m.t === 'list' && ok) {
            sock.write(JSON.stringify({ t: 'sessions', sessions: [] }) + '\n');
          } else if (m.t === 'bye') {
            sock.end();
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const a = server.address() as { port: number };
      resolve({ server, addr: `127.0.0.1:${a.port}` });
    });
  });
}

describe('agent client', () => {
  let srv: { server: Server; addr: string };
  beforeAll(async () => {
    srv = await fakeServer('tok');
  });
  afterAll(() => srv.server.close());

  it('fetches the session list with the token', async () => {
    const sessions = await fetchSessions({ addr: srv.addr, token: 'tok' });
    expect(sessions).toEqual([{ session: 's1', host: 'PUB400.COM', device: 'QPADEV0001', connected: true, seq: 7, inhibited: 'none' }]);
  });

  it('rejects a wrong token and a dead server', async () => {
    await expect(fetchSessions({ addr: srv.addr, token: 'nope' })).rejects.toThrow(/bad token/);
    await expect(fetchSessions({ addr: '127.0.0.1:1', token: 'tok' }, 500)).rejects.toThrow();
  });

  it('reads token files newest first and drops junk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tn5250-agent-'));
    try {
      writeFileSync(join(dir, '10.json'), JSON.stringify({ pid: 10, addr: '127.0.0.1:1', token: 'a', started: '2026-11-14T10:00:00Z', label: 'old' }));
      writeFileSync(join(dir, '20.json'), JSON.stringify({ pid: 20, addr: '127.0.0.1:2', token: 'b', started: '2026-11-14T11:00:00Z' }));
      writeFileSync(join(dir, 'junk.json'), '{');
      writeFileSync(join(dir, 'notes.txt'), 'x');
      const list = listTokens(dir);
      expect(list.map((t) => t.pid)).toEqual([20, 10]);
      expect(list[1]?.label).toBe('old');
      expect(existsSync(join(dir, 'junk.json'))).toBe(false);
      expect(listTokens(join(dir, 'missing'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('token dir follows the console terminal: env override, APPDATA on Windows, XDG elsewhere', () => {
    expect(tokenDir({ TN5250_TUI_CONFIG: '/x/sites.json' }, 'linux')).toBe(join('/x/sites.json', '..', 'agent'));
    expect(tokenDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32')).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'tn5250-tui', 'agent'));
    expect(tokenDir({ XDG_CONFIG_HOME: '/home/a/.config' }, 'linux')).toBe(join('/home/a/.config', 'tn5250-tui', 'agent'));
  });

  it('finds the binary: the setting wins, then PATH, then the installer folder', () => {
    expect(findBinary(' /opt/tn5250-tui ', {}, 'linux', () => false)).toBe('/opt/tn5250-tui');
    const have = new Set([join('/usr/local/bin', 'tn5250-tui')]);
    expect(findBinary('', { PATH: '/bin:/usr/local/bin' }, 'linux', (p) => have.has(p))).toBe(join('/usr/local/bin', 'tn5250-tui'));
    const win = new Set([join('C:\\Users\\a\\AppData\\Local', 'Programs', 'tn5250-tui', 'tn5250-tui.exe')]);
    expect(findBinary('', { PATH: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', (p) => win.has(p))).toBe(join('C:\\Users\\a\\AppData\\Local', 'Programs', 'tn5250-tui', 'tn5250-tui.exe'));
    expect(findBinary('', { PATH: '/bin' }, 'linux', () => false)).toBeUndefined();
  });

  it('builds attach arguments and merges .mcp.json', () => {
    expect(attachArgs({ addr: '127.0.0.1:5', token: 't' }, 's2')).toEqual(['attach', '--addr', '127.0.0.1:5', '--token', 't', 's2']);
    const fresh = JSON.parse(mergeMcpJson(undefined, { binary: 'tn5250-tui', site: 'agent', readOnly: true })) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(fresh.mcpServers.tn5250).toEqual({ command: 'tn5250-tui', args: ['mcp', '--site', 'agent', '--read-only'] });
    const merged = JSON.parse(mergeMcpJson('{"mcpServers":{"other":{"command":"x"}},"note":1}', { binary: 'C:\\t\\tn5250-tui.exe', site: '', readOnly: false })) as { mcpServers: Record<string, unknown>; note: number };
    expect(Object.keys(merged.mcpServers)).toEqual(['other', 'tn5250']);
    expect(merged.note).toBe(1);
    expect(merged.mcpServers.tn5250).toEqual({ command: 'C:\\t\\tn5250-tui.exe', args: ['mcp'] });
    expect(() => mergeMcpJson('{oops', { binary: 'x', site: '', readOnly: true })).toThrow();
  });

  it('sites file sits beside the token directory, or is the env override', () => {
    expect(sitesPath({ TN5250_TUI_CONFIG: '/x/sites.json' }, 'linux')).toBe('/x/sites.json');
    expect(sitesPath({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32')).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'tn5250-tui', 'sites.json'));
    expect(sitesPath({ XDG_CONFIG_HOME: '/home/a/.config' }, 'linux')).toBe(join('/home/a/.config', 'tn5250-tui', 'sites.json'));
  });

  it('enrolls a site into the sites file and removes it again', () => {
    const site = { name: 'agent', host: 'PUB400.COM', port: 23, tls: false, trustAnyCertificate: false, user: 'ME', password: 'pw', screenSize: '27x132', codePage: 37, deviceName: '', autoSignon: true };
    type Sites = { sites: Array<Record<string, unknown>>; lastUsed: string };
    const fresh = JSON.parse(enrollSite(undefined, site)) as Sites;
    expect(fresh).toEqual({ sites: [site], lastUsed: '' });
    // Replaced by name (case-insensitively, as the console terminal matches), unknown fields kept, others untouched.
    const existing = JSON.stringify({ sites: [{ name: 'Agent', host: 'old', port: 992, demo: true, password: 'x' }, { name: 'other', host: 'h' }], lastUsed: 'Agent', defaults: { codePage: 37 } });
    const merged = JSON.parse(enrollSite(existing, site)) as Sites & { defaults: unknown };
    expect(merged.sites).toEqual([{ ...site, demo: true }, { name: 'other', host: 'h' }]);
    expect(merged.defaults).toEqual({ codePage: 37 });
    expect(merged.lastUsed).toBe('Agent');
    expect(() => enrollSite('{nope', site)).toThrow();
    const removed = JSON.parse(removeSite(JSON.stringify(merged), 'AGENT') as string) as Sites;
    expect(removed.sites).toEqual([{ name: 'other', host: 'h' }]);
    expect(removed.lastUsed).toBe('');
    expect(removeSite(JSON.stringify(removed), 'agent')).toBeUndefined();
    expect(removeSite(undefined, 'agent')).toBeUndefined();
  });
});

describe('AI Agent page status helpers', () => {
  const site = { name: 'Agent', host: 'pub400.com', port: 23, tls: false, trustAnyCertificate: false, user: 'DEMOUSER', password: 'x', screenSize: '24x80', codePage: 37, deviceName: '', autoSignon: true };

  it('enrolledUser names the user and host of the site, matched case-insensitively', () => {
    const text = enrollSite(undefined, site);
    expect(enrolledUser(text, 'agent')).toBe('DEMOUSER@pub400.com');
    expect(enrolledUser(text, 'other')).toBe('');
    expect(enrolledUser(undefined, 'agent')).toBe('');
    expect(enrolledUser('{not json', 'agent')).toBe('');
  });

  it('mcpHasServer sees the tn5250 server only', () => {
    expect(mcpHasServer(undefined)).toBe(false);
    expect(mcpHasServer('{"mcpServers":{"other":{}}}')).toBe(false);
    expect(mcpHasServer(mergeMcpJson(undefined, { binary: 'tn5250-tui', site: 'agent', readOnly: true }))).toBe(true);
    expect(mcpHasServer('nope')).toBe(false);
  });
});
