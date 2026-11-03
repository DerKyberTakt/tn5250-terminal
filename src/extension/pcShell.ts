import { spawn } from 'node:child_process';

/**
 * Runs a PC Organizer command (STRPCCMD) through the user's shell: cmd.exe on Windows,
 * /bin/sh elsewhere, like PC Organizer and tn5250j do. With `wait` (PAUSE(*YES)) the
 * promise resolves when the command exits; otherwise as soon as it started.
 */
export function runPcCommand(command: string, wait: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: 'ignore', windowsHide: false, detached: !wait });
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    child.on('error', (err) => done(err));
    if (wait) {
      child.on('exit', () => done());
    } else {
      child.on('spawn', () => {
        child.unref();
        done();
      });
    }
  });
}
