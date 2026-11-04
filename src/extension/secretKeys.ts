import type * as vscode from 'vscode';
import type { TerminalSettings } from '../shared/settings';

/** Only what the secret store offers; makes the key logic testable without VS Code. */
export type SecretStore = Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>;

/**
 * Secret-store key for a sign-on password: one per USER@host, like the desktop app, so a
 * profile can never pick up the password another user saved for the same host. Profiles
 * without a user name keep the key of earlier versions (their own name, or the host).
 */
export function passwordKey(profileName: string, host: string, user = ''): string {
  const u = user.trim().toUpperCase();
  return u ? `tn5250.password:${u}@${host.trim().toLowerCase()}` : legacyPasswordKey(profileName, host);
}

/** The key of versions before 0.2.0: per profile name, or per host for unnamed profiles. */
export function legacyPasswordKey(profileName: string, host: string): string {
  return `tn5250.password:${profileName || host}`;
}

export function certPassphraseKey(profileName: string, host: string): string {
  return `tn5250.certpass:${profileName || host}`;
}

/**
 * The saved password for a profile. A password saved by an earlier version under the
 * profile's own name moves to the USER@host key the first time it is found (copy, then
 * delete). There is no fallback to any other key: the host-only key of unnamed profiles
 * cannot say whose password it holds, so it is never read for a user, and a missing
 * password is missing.
 */
export async function findPassword(secrets: SecretStore, profile: Pick<TerminalSettings, 'name' | 'host'>, user: string): Promise<string | undefined> {
  const key = passwordKey(profile.name, profile.host, user);
  const current = await secrets.get(key);
  if (current !== undefined || !user.trim() || !profile.name) return current;
  const legacy = legacyPasswordKey(profile.name, profile.host);
  const old = await secrets.get(legacy);
  if (old === undefined) return undefined;
  await secrets.store(key, old);
  await secrets.delete(legacy);
  return old;
}

/**
 * Forgets the secrets of a removed profile: its own legacy password key and certificate
 * passphrase always; its USER@host password only when no remaining profile signs on
 * with the same user at the same host.
 */
export async function forgetProfileSecrets(secrets: SecretStore, removed: TerminalSettings, remaining: TerminalSettings[]): Promise<void> {
  await secrets.delete(legacyPasswordKey(removed.name, removed.host));
  await secrets.delete(certPassphraseKey(removed.name, removed.host));
  const user = removed.signonUser.trim();
  if (!user) return;
  const key = passwordKey(removed.name, removed.host, user);
  const shared = remaining.some((s) => passwordKey(s.name, s.host, s.signonUser) === key);
  if (!shared) await secrets.delete(key);
}

