/* Builds test/fixtures/lab-6.0.0/ from the split lab, once, on the
 * maintainer's machine. The test gate then reads only this repo: never a
 * live folder that someone may rebuild underneath it (0.7.0 was stopped by
 * exactly that: the lab moved from -lab to the final manifests and six lab
 * tests changed meaning overnight).
 *
 *   node test/fixtures/build-lab-fixture.mjs [LAB] [SCAFFOLD]
 *     LAB       default ~/projects/mypka-split-lab (icor-for-life/, mypka/)
 *     SCAFFOLD  default ~/projects/icor-for-life-scaffold (1.34.1 at f7dd5f0)
 *
 * Three trees go into one gzipped JSON bundle (a bundle, not a folder of
 * files: a nested `.gitignore` would hide fixture files from git, and other
 * plugins' `main.js` would sit in this repo's tree for a scanner to read):
 *   icor-for-life   ICOR for Life 2.0.0, the lab's working tree minus .git
 *   mypka           myPKA 6.0.0, the same
 *   scaffold-1.34.1 the pre-split Scaffold at f7dd5f0 (git archive)
 *
 * Binary files (images, the example PDF) are replaced by a short text stub
 * that names the real hash, and every manifest that lists the real hash
 * gets the stub's hash instead. Equal bytes stay equal and different bytes
 * stay different, so every answer the engine gives is the same; the build
 * checks that per tree and per manifest before it writes. Text is kept byte
 * for byte: the engine reads frontmatter, generated headers and hashes.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, lstatSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const LAB = process.argv[2] || join(homedir(), 'projects', 'mypka-split-lab');
const SCAFFOLD = process.argv[3] || join(homedir(), 'projects', 'icor-for-life-scaffold');
const PRE_SPLIT_COMMIT = 'f7dd5f0';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'lab-6.0.0');

const sha = (b) => createHash('sha256').update(b).digest('hex');
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const utf8 = new TextDecoder('utf-8', { fatal: true });
const isText = (buf) => { try { utf8.decode(buf); return true; } catch { return false; } };

function walk(root, dir = root, out = new Map()) {
  for (const name of readdirSync(dir).sort()) {
    if (name === '.git') continue;
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new Error('symlink in the lab, not supported by the bundle: ' + relative(root, abs));
    if (st.isDirectory()) walk(root, abs, out);
    else out.set(relative(root, abs).split('\\').join('/'), readFileSync(abs));
  }
  return out;
}

const trees = {};
const provenance = { built: new Date().toISOString().slice(0, 10), sources: {}, stubs: {} };

for (const name of ['icor-for-life', 'mypka']) {
  const dir = join(LAB, name);
  const dirty = git(dir, 'status', '--porcelain');
  if (dirty) throw new Error(name + ' has uncommitted changes; build from a clean commit');
  provenance.sources[name] = { path: '<lab>/' + name, commit: git(dir, 'rev-parse', 'HEAD'), subject: git(dir, 'log', '-1', '--format=%s') };
  trees[name] = walk(dir);
}
{
  const tmp = mkdtempSync(join(tmpdir(), 'lab-fixture-'));
  try {
    execFileSync('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', SCAFFOLD, PRE_SPLIT_COMMIT, tmp]);
    trees['scaffold-1.34.1'] = walk(tmp);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  provenance.sources['scaffold-1.34.1'] = { path: '<scaffold>', commit: git(SCAFFOLD, 'rev-parse', PRE_SPLIT_COMMIT) };
}

/* 1. stub every binary, the same stub for the same bytes */
const swap = new Map(); /* real sha256 -> stub sha256 */
for (const [tree, files] of Object.entries(trees)) {
  for (const [p, buf] of files) {
    if (buf.length === 0 || isText(buf)) continue;
    const real = sha(buf);
    const stub = Buffer.from('binary stub: the real file is ' + buf.length + ' bytes, sha256 ' + real + '\n');
    swap.set(real, sha(stub));
    files.set(p, stub);
    (provenance.stubs[tree] = provenance.stubs[tree] || []).push(p);
  }
}

/* 2. every manifest learns the stub hashes */
const MANIFESTS = /(^|\/)\.(icor-for-life|mypka)\/manifest\.json$/;
function matches(tree, files) {
  /* which listed paths hash-match their bytes, per manifest in this tree */
  const out = [];
  for (const [mp, buf] of files) {
    if (!MANIFESTS.test(mp)) continue;
    const m = JSON.parse(buf.toString('utf8'));
    const entries = Array.isArray(m.files) ? m.files.map((f) => [f.path, f.sha256]) : Object.entries(m.files || {});
    for (const [p, h] of entries) if (files.has(p)) out.push(mp + ' ' + p + ' ' + (sha(files.get(p)) === h));
  }
  return out.sort().join('\n');
}
for (const [tree, files] of Object.entries(trees)) {
  for (const [mp, buf] of files) {
    if (!MANIFESTS.test(mp)) continue;
    let text = buf.toString('utf8');
    for (const [real, stub] of swap) text = text.split(real).join(stub);
    files.set(mp, Buffer.from(text));
  }
  for (const [p, buf] of files) {
    if (MANIFESTS.test(p) || (provenance.stubs[tree] || []).includes(p) || !isText(buf)) continue;
    const t = buf.toString('utf8');
    for (const real of swap.keys()) if (t.includes(real)) throw new Error(tree + '/' + p + ' carries a binary hash outside a manifest');
  }
}

/* 3. fidelity: with stubs and swapped hashes, every manifest entry matches
   its bytes exactly when it matched on the real bytes */
function realMatches(tree) {
  const dir = tree === 'scaffold-1.34.1' ? null : join(LAB, tree);
  let files;
  if (dir) files = walk(dir);
  else {
    const tmp = mkdtempSync(join(tmpdir(), 'lab-fixture-'));
    try { execFileSync('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', SCAFFOLD, PRE_SPLIT_COMMIT, tmp]); files = walk(tmp); } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  return matches(tree, files);
}
for (const tree of Object.keys(trees)) {
  const was = realMatches(tree);
  const now = matches(tree, trees[tree]);
  if (was !== now) throw new Error('stubbing changed a hash answer in ' + tree);
}

/* 4. write: sorted keys, text as text, a fixed gzip header */
const bundle = { format: 1, trees: {} };
for (const tree of Object.keys(trees).sort()) {
  bundle.trees[tree] = {};
  for (const p of [...trees[tree].keys()].sort()) {
    const buf = trees[tree].get(p);
    bundle.trees[tree][p] = isText(buf) ? { t: buf.toString('utf8') } : { b: buf.toString('base64') };
  }
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'trees.json.gz'), gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 }));
provenance.counts = Object.fromEntries(Object.entries(trees).map(([t, f]) => [t, f.size]));
writeFileSync(join(OUT, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log('wrote', join(OUT, 'trees.json.gz'), statSync(join(OUT, 'trees.json.gz')).size, 'bytes;', JSON.stringify(provenance.counts));
