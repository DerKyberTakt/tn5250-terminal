// Fails the package step when a file the code references is not going to be in the
// VSIX. .vscodeignore is a whitelist, so a new icon or stylesheet that works in the
// Extension Development Host is silently missing from the Marketplace build unless it
// is listed there (that is how 0.1.6 and 0.1.7 shipped without the session icons).
//
// Usage: node scripts/check-package.mjs   (run by `npm run package` before vsce)
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// Everything `vsce ls` would pack, as forward-slash paths relative to the root.
const packed = new Set(
  execFileSync('npx', ['vsce', 'ls', '--no-dependencies'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' })
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\\/g, '/'))
    .filter(Boolean),
);
const packedNames = new Set([...packed].map((p) => p.split('/').pop()));

// Asset names the sources mention: 'x.svg', 'x.css', 'x.js', 'x.png', plus media/... and dist/... paths.
const names = new Set();
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|json)$/.test(e)) {
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(/'([A-Za-z0-9_-]+\.(?:svg|css|js|png))'/g)) names.add(m[1]);
      for (const m of text.matchAll(/["'`]((?:media|dist)\/[A-Za-z0-9_./-]+\.[a-z]+)["'`]/g)) names.add(m[1]);
    }
  }
};
walk(join(root, 'src'));
for (const m of readFileSync(join(root, 'package.json'), 'utf8').matchAll(/"((?:media|dist)\/[A-Za-z0-9_./-]+)"/g)) names.add(m[1]);

const missing = [...names].filter((n) => (n.includes('/') ? !packed.has(n) : !packedNames.has(n)));
if (missing.length) {
  console.error('check-package: these files are referenced by the extension but would not be in the VSIX (add them to .vscodeignore as !path):');
  for (const m of missing) console.error('  ' + m);
  process.exit(1);
}
console.log(`check-package: ${names.size} referenced files all present in the ${packed.size}-file package (${relative(root, root) || '.'})`);
