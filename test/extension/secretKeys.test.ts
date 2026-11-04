import { describe, expect, it } from 'vitest';
import { findPassword, forgetProfileSecrets, legacyPasswordKey, passwordKey, type SecretStore } from '../../src/extension/secretKeys';
import { SETTINGS_DEFAULTS, type TerminalSettings } from '../../src/shared/settings';

function store(initial: Record<string, string> = {}): SecretStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: async (k) => map.get(k),
    store: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
  };
}

const profile = (over: Partial<TerminalSettings>): TerminalSettings => ({ ...SETTINGS_DEFAULTS, host: 'pub400.com', name: 'Dev', ...over });

describe('password keys', () => {
  it('are per USER@host, case-folded, and never the host alone', () => {
    expect(passwordKey('Dev', 'PUB400.com', 'alex')).toBe('tn5250.password:ALEX@pub400.com');
    expect(passwordKey('Dev', 'pub400.com', ' Alex ')).toBe('tn5250.password:ALEX@pub400.com');
    expect(passwordKey('Dev', 'pub400.com')).toBe(legacyPasswordKey('Dev', 'pub400.com'));
    expect(legacyPasswordKey('', 'pub400.com')).toBe('tn5250.password:pub400.com');
  });

  it('a saved password is found under its USER@host key', async () => {
    const s = store({ 'tn5250.password:ALEX@pub400.com': 'pw' });
    expect(await findPassword(s, profile({}), 'alex')).toBe('pw');
  });

  it('migrates a password saved under the profile name: copy, then delete', async () => {
    const s = store({ 'tn5250.password:Dev': 'old' });
    expect(await findPassword(s, profile({}), 'alex')).toBe('old');
    expect(s.map.get('tn5250.password:ALEX@pub400.com')).toBe('old');
    expect(s.map.has('tn5250.password:Dev')).toBe(false);
  });

  it('never falls back to another key: user B does not get user A\'s password', async () => {
    const s = store({ 'tn5250.password:ALEX@pub400.com': 'pw', 'tn5250.password:pub400.com': 'hostpw' });
    expect(await findPassword(s, profile({}), 'bob')).toBeUndefined();
    expect(await findPassword(s, profile({ name: '' }), 'bob')).toBeUndefined();
  });

  it('a profile without a user name keeps using its legacy key', async () => {
    const s = store({ 'tn5250.password:Dev': 'old' });
    expect(await findPassword(s, profile({}), '')).toBe('old');
    expect(s.map.has('tn5250.password:Dev')).toBe(true);
  });
});

describe('removing a profile', () => {
  it('deletes its legacy password, certificate passphrase and USER@host password', async () => {
    const s = store({ 'tn5250.password:Dev': 'a', 'tn5250.certpass:Dev': 'b', 'tn5250.password:ALEX@pub400.com': 'c' });
    await forgetProfileSecrets(s, profile({ signonUser: 'alex' }), []);
    expect(s.map.size).toBe(0);
  });

  it('keeps the USER@host password while another profile signs on with the same user at the same host', async () => {
    const s = store({ 'tn5250.password:Dev': 'a', 'tn5250.password:ALEX@pub400.com': 'c' });
    await forgetProfileSecrets(s, profile({ signonUser: 'alex' }), [profile({ name: 'Dev 2', signonUser: 'ALEX' })]);
    expect(s.map.has('tn5250.password:Dev')).toBe(false);
    expect(s.map.get('tn5250.password:ALEX@pub400.com')).toBe('c');
  });
});
