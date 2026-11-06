import * as vscode from 'vscode';
import { signonGate } from '../shared/signonGate';
import { certPassphraseKey, legacyPasswordKey, passwordKey } from './secretKeys';
import { readDefaults, readSessions } from './settingsStore';

export { certPassphraseKey, findPassword, forgetProfileSecrets, legacyPasswordKey, passwordKey, type SecretStore } from './secretKeys';

export async function setCertPassphraseInteractive(context: vscode.ExtensionContext, target: number): Promise<void> {
  const name = target < 0 ? 'Defaults' : (readSessions()[target]?.name ?? readSessions()[target]?.host ?? '');
  const host = target < 0 ? readDefaults().host : (readSessions()[target]?.host ?? '');
  const value = await vscode.window.showInputBox({
    title: `TN5250: certificate passphrase for ${name}`,
    prompt: 'Passphrase of the client certificate or key. Stored in the VS Code secret store. Leave empty to remove.',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) return;
  const key = certPassphraseKey(target < 0 ? '' : name, host);
  if (value) await context.secrets.store(key, value);
  else await context.secrets.delete(key);
  void vscode.window.showInformationMessage(value ? 'TN5250: passphrase stored.' : 'TN5250: passphrase removed.');
}

export async function setPasswordInteractive(context: vscode.ExtensionContext, target: number): Promise<void> {
  const name = target < 0 ? 'Defaults' : (readSessions()[target]?.name ?? readSessions()[target]?.host ?? '');
  const host = target < 0 ? readDefaults().host : (readSessions()[target]?.host ?? '');
  const user = target < 0 ? readDefaults().signonUser : (readSessions()[target]?.signonUser ?? readDefaults().signonUser);
  const value = await vscode.window.showInputBox({
    title: `TN5250: sign-on password for ${user.trim() ? `${user.trim().toUpperCase()} at ${host}` : name}`,
    prompt: 'Stored in the VS Code secret store (protected by the operating system keyring where there is one). Leave empty to remove.',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) return;
  const key = passwordKey(target < 0 ? '' : name, host, user);
  if (!user.trim()) await context.secrets.delete(legacyPasswordKey(target < 0 ? '' : name, host));
  if (value) await context.secrets.store(key, value);
  else await context.secrets.delete(key);
  // A new password: a paused bypass sign-on may try again.
  signonGate.rearmAll();
  void vscode.window.showInformationMessage(value ? 'TN5250: password stored.' : 'TN5250: password removed.');
}
