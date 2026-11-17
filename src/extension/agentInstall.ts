/**
 * Installs tn5250-tui (the console terminal, whose `mcp` command is the agent's server)
 * from its GitHub release into a folder the extension owns, so the AI Agent page needs no
 * PATH work from the user. Pure Node apart from the injected pieces (fetch, extract), so
 * the naming, the checksum check and the flow can be tested without the network.
 *
 * Only github.com and GitHub's download hosts are contacted, over HTTPS; the archive is
 * checked against the release's SHA256SUMS before it is unpacked.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';

export const REPO = 'DerKyberTakt/tn5250-tui';

/** The release asset for a platform, or undefined when the release carries none for it. */
export function assetName(platform: NodeJS.Platform, arch: string, tag: string): string | undefined {
  const goos = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined;
  const goarch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : undefined;
  if (!goos || !goarch) return undefined;
  if (goos === 'darwin' && goarch !== 'arm64') return undefined; // the release builds Apple silicon only
  const ver = tag.replace(/^v/, '');
  return `tn5250-tui_${ver}_${goos}_${goarch}.${goos === 'windows' ? 'zip' : 'tar.gz'}`;
}

/** The binary's file name inside the archive. */
export function binaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'tn5250-tui.exe' : 'tn5250-tui';
}

/** The tag a `releases/latest` redirect points at; undefined when there is no release. */
export function tagFromLocation(location: string | null | undefined): string | undefined {
  if (!location) return undefined;
  const m = /\/releases\/tag\/([^/?#]+)$/.exec(location);
  return m ? decodeURIComponent(m[1]!) : undefined;
}

/** sha256sum output ("<hex>  <name>" or "<hex> *<name>") as name -> lowercase hex. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (m) out.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return out;
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Only github.com and GitHub's download hosts, over HTTPS. */
export function allowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com'));
  } catch {
    return false;
  }
}

export interface InstallDeps {
  /** fetch with redirects followed (the default), used for the checksum file and the archive. */
  fetch: (url: string, init?: { redirect?: 'follow' | 'manual' }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;
  /** Unpacks the archive into dir (tar handles .zip and .tar.gz on Windows 10+, macOS and Linux). */
  extract: (archive: string, dir: string) => Promise<void>;
  platform: NodeJS.Platform;
  arch: string;
  /** Progress line for the UI. */
  report?: (text: string) => void;
}

/**
 * The default extractor: `tar -xf`, which reads zip and tar.gz alike on every supported
 * platform. It runs inside dir with the archive's bare name: Windows' bsdtar reads a
 * `C:\...` path as a remote host ("Cannot connect to C"), so no absolute path is passed.
 */
export function tarExtract(archive: string, dir: string): Promise<void> {
  // Windows: the system's bsdtar (System32) reads zip; a GNU tar from Git on PATH does not.
  const tar = process.platform === 'win32' && process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', basename(archive)], { cwd: dir, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`tar: ${stderr?.toString().trim() || err.message}`));
      else resolve();
    });
  });
}

const MAX_ARCHIVE = 64 << 20;

/** The latest release tag of the console terminal. */
export async function latestTag(deps: Pick<InstallDeps, 'fetch'>): Promise<string> {
  const r = await deps.fetch(`https://github.com/${REPO}/releases/latest`, { redirect: 'manual' });
  if (r.status === 404) throw new Error('tn5250-tui has no published release yet');
  const tag = tagFromLocation(r.headers.get('location'));
  if (!tag) throw new Error(`releases/latest answered HTTP ${r.status} without a release tag`);
  return tag;
}

/**
 * Downloads the release for this platform into `<dir>/<tag>`, checks it against
 * SHA256SUMS, unpacks it and returns the binary's path. The folder is replaced when the
 * same tag is installed again.
 */
export async function installRelease(dir: string, tag: string, deps: InstallDeps): Promise<string> {
  const asset = assetName(deps.platform, deps.arch, tag);
  if (!asset) throw new Error(`no tn5250-tui release for ${deps.platform}/${deps.arch}; build it from source (github.com/${REPO})`);
  const base = `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}`;
  const get = async (name: string, limit: number): Promise<Uint8Array> => {
    const url = `${base}/${name}`;
    if (!allowedUrl(url)) throw new Error(`refusing ${url}`);
    const r = await deps.fetch(url);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    const data = new Uint8Array(await r.arrayBuffer());
    if (data.length > limit) throw new Error(`${name}: too large (${data.length} bytes)`);
    return data;
  };
  deps.report?.(`Reading SHA256SUMS of ${tag}…`);
  const sums = parseSums(Buffer.from(await get('SHA256SUMS', 64 << 10)).toString('utf8'));
  const want = sums.get(asset);
  if (!want) throw new Error(`${asset} is not part of release ${tag}`);
  deps.report?.(`Downloading ${asset}…`);
  const data = await get(asset, MAX_ARCHIVE);
  const got = sha256(data);
  if (got !== want) throw new Error(`${asset}: checksum mismatch (got ${got}, release says ${want})`);
  const target = join(dir, tag);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const archive = join(target, asset);
  writeFileSync(archive, data);
  deps.report?.(`Unpacking ${asset}…`);
  await deps.extract(archive, target);
  rmSync(archive, { force: true });
  const bin = join(target, binaryName(deps.platform));
  if (!existsSync(bin)) throw new Error(`${asset} holds no ${binaryName(deps.platform)}`);
  if (deps.platform !== 'win32') chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'current'), tag);
  return bin;
}

/** The binary of the release installed last into dir, if it is still there. */
export function installedBinary(dir: string, platform: NodeJS.Platform): string | undefined {
  try {
    const tag = readFileSync(join(dir, 'current'), 'utf8').trim();
    const bin = join(dir, tag, binaryName(platform));
    return tag && existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}
