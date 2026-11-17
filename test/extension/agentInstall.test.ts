import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowedUrl, assetName, installRelease, installedBinary, latestTag, parseSums, sha256, tagFromLocation } from '../../src/extension/agentInstall';

describe('agent binary install', () => {
  it('names the release asset for the platform', () => {
    expect(assetName('win32', 'x64', 'v0.2.0')).toBe('tn5250-tui_0.2.0_windows_amd64.zip');
    expect(assetName('win32', 'arm64', '0.2.0')).toBe('tn5250-tui_0.2.0_windows_arm64.zip');
    expect(assetName('linux', 'x64', 'v0.2.0')).toBe('tn5250-tui_0.2.0_linux_amd64.tar.gz');
    expect(assetName('darwin', 'arm64', 'v0.2.0')).toBe('tn5250-tui_0.2.0_darwin_arm64.tar.gz');
    expect(assetName('darwin', 'x64', 'v0.2.0')).toBeUndefined();
    expect(assetName('freebsd', 'x64', 'v0.2.0')).toBeUndefined();
  });

  it('reads the tag from the releases/latest redirect', () => {
    expect(tagFromLocation('https://github.com/DerKyberTakt/tn5250-tui/releases/tag/v0.2.0')).toBe('v0.2.0');
    expect(tagFromLocation('https://github.com/DerKyberTakt/tn5250-tui/releases')).toBeUndefined();
    expect(tagFromLocation(null)).toBeUndefined();
  });

  it('parses sha256sum output and allows only GitHub hosts', () => {
    const sums = parseSums('abc\n' + 'a'.repeat(64) + '  tn5250-tui_0.2.0_windows_amd64.zip\n' + 'b'.repeat(64) + ' *SHA256SUMS\n');
    expect(sums.get('tn5250-tui_0.2.0_windows_amd64.zip')).toBe('a'.repeat(64));
    expect(sums.get('SHA256SUMS')).toBe('b'.repeat(64));
    expect(allowedUrl('https://github.com/x/y/releases/download/v1/a.zip')).toBe(true);
    expect(allowedUrl('https://objects.githubusercontent.com/x')).toBe(true);
    expect(allowedUrl('http://github.com/x')).toBe(false);
    expect(allowedUrl('https://example.com/github.com')).toBe(false);
  });

  it('downloads, verifies and unpacks the release for this platform; a wrong checksum is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tn5250-install-'));
    try {
      const archive = new TextEncoder().encode('fake archive bytes');
      const asset = assetName('linux', 'x64', 'v0.2.0')!;
      const good = `${sha256(archive)}  ${asset}\n`;
      const urls: string[] = [];
      const fetch = (sumsText: string) => async (url: string, init?: { redirect?: string }) => {
        urls.push(url);
        if (url.endsWith('/releases/latest')) {
          expect(init?.redirect).toBe('manual');
          return { ok: false, status: 302, headers: { get: () => 'https://github.com/DerKyberTakt/tn5250-tui/releases/tag/v0.2.0' }, arrayBuffer: async () => new ArrayBuffer(0) };
        }
        const body = url.endsWith('/SHA256SUMS') ? new TextEncoder().encode(sumsText) : archive;
        return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
      };
      const extract = async (file: string, into: string) => {
        expect(readFileSync(file)).toEqual(Buffer.from(archive));
        mkdirSync(into, { recursive: true });
        writeFileSync(join(into, 'tn5250-tui'), '#!/bin/sh\n');
      };
      const tag = await latestTag({ fetch: fetch(good) });
      expect(tag).toBe('v0.2.0');
      const reports: string[] = [];
      const bin = await installRelease(dir, tag, { fetch: fetch(good), extract, platform: 'linux', arch: 'x64', report: (t) => reports.push(t) });
      expect(bin).toBe(join(dir, 'v0.2.0', 'tn5250-tui'));
      expect(installedBinary(dir, 'linux')).toBe(bin);
      expect(urls.filter((u) => u.includes('/releases/download/v0.2.0/'))).toEqual([
        'https://github.com/DerKyberTakt/tn5250-tui/releases/download/v0.2.0/SHA256SUMS',
        `https://github.com/DerKyberTakt/tn5250-tui/releases/download/v0.2.0/${asset}`,
      ]);
      expect(reports.at(-1)).toContain('Unpacking');

      const bad = `${'0'.repeat(64)}  ${asset}\n`;
      await expect(installRelease(dir, 'v0.2.0', { fetch: fetch(bad), extract, platform: 'linux', arch: 'x64' })).rejects.toThrow(/checksum mismatch/);
      await expect(installRelease(dir, 'v0.2.0', { fetch: fetch(''), extract, platform: 'linux', arch: 'x64' })).rejects.toThrow(/not part of release/);
      await expect(installRelease(dir, 'v0.2.0', { fetch: fetch(good), extract, platform: 'darwin', arch: 'x64' })).rejects.toThrow(/no tn5250-tui release/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
