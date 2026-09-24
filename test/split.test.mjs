/* THE SPLIT GATES (0.7.0).
 *
 * ICOR for Life Scaffold 2.0.0 hands the AI team to a second product, myPKA.
 * These tests run the engine against the real lab folders on disk (Flint's
 * spec, section 6), through a disk-backed vault that answers like the
 * desktop adapter, with the two lab manifests as the remotes. The fixtures
 * are copies in a scratch folder; nothing is ever written inside the lab.
 *
 * The lab lives on the maintainer's machine, not in CI. Without it the lab
 * tests skip and say so; the unit tests at the top run everywhere.
 *   MYPKA_SPLIT_LAB     default ~/Desktop/mypka-split-lab
 *   ICOR_SCAFFOLD_REPO  default ~/projects/icor-for-life-scaffold (for the
 *                       1.34.1 pre-split fixture and the real 2.0.0 history)
 *   SC_MAIN             an alternate main.js, for the mutation runs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { diskVault } from './disk-vault.mjs';

const require = createRequire(import.meta.url);
const { engine } = require(process.env.SC_MAIN ? resolve(process.env.SC_MAIN) : '../main.js');

const sha = (s) => createHash('sha256').update(s).digest('hex');
const hash = async (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');

/* ============================================================ units ==== */

test('normalizeManifest reads the list shape and the map shape into one shape, and skips "self"', () => {
  const list = engine.normalizeManifest({ schema: 1, version: '1.34.1', files: [
    { path: 'a/Guidelines/GL-1.md', sha256: 'x', kind: 'guideline', example: false },
    { path: '04 Inner World/Notes/Example.md', sha256: 'y', kind: 'doc', example: true },
  ] });
  assert.equal(list.shape, 'list');
  assert.equal(list.files.get('a/Guidelines/GL-1.md').kind, 'guideline');
  assert.equal(list.files.get('04 Inner World/Notes/Example.md').example, true);
  assert.equal(list.examplesKnown, true);

  const map = engine.normalizeManifest({ schema: 1, version: '2.0.0-lab', files: { '.icor-for-life/manifest.json': 'self', 'x/SOPs/SOP-1.md': 'z', '.obsidian/workspace.json': 'w' }, seed: ['.obsidian/workspace.json'] });
  assert.equal(map.shape, 'map');
  assert.equal(map.files.size, 2, '"self" is the manifest itself, never a file to check');
  assert.equal(map.files.get('x/SOPs/SOP-1.md').kind, 'sop');
  assert.equal(map.files.get('.obsidian/workspace.json').seed, true);
  assert.equal(map.examplesKnown, false);

  const two = engine.normalizeManifest({ schema: 2, files: { 'n.md': 'q' }, examples: ['n.md'] });
  assert.equal(two.schema, 2);
  assert.equal(two.files.get('n.md').example, true);
});

test('RED: normalizeManifest refuses what it cannot read, in a sentence', () => {
  assert.throws(() => engine.normalizeManifest({ hello: 'world' }), /not a scaffold manifest/);
  assert.throws(() => engine.normalizeManifest({ files: 'nope' }), /not a scaffold manifest/);
  assert.throws(() => engine.normalizeManifest({ schema: 3, files: {} }), /schema 3/);
  assert.throws(() => engine.normalizeManifest([]), /not a scaffold manifest/);
});

test('kindOf is the builder\'s kind_of, so no finding ever reads "Canonical undefined"', () => {
  const cases = { 'a.base': 'base', 'x/Guidelines/y.md': 'guideline', 'x/SOPs/y.md': 'sop', 'x/Workstreams/y.md': 'workstream', '06 AI Team/Agents/Penn/AGENT.md': 'agent', 'x/Scripts/y.py': 'script', 'x/Brand/y.png': 'asset', '.obsidian/app.json': 'config', '.claude/agents/penn.md': 'claude', 'README.md': 'doc' };
  for (const [p, k] of Object.entries(cases)) assert.equal(engine.kindOf(p), k, p);
});

test('compareVersions follows semver precedence: a pre-release is below its release', () => {
  assert.equal(engine.compareVersions('2.0.0-lab', '2.0.0'), -1);
  assert.equal(engine.compareVersions('2.0.0', '2.0.0-lab'), 1);
  assert.equal(engine.compareVersions('2.0.0-lab', '2.0.0-lab'), 0);
  assert.equal(engine.compareVersions('2.0.0-alpha.2', '2.0.0-alpha.10'), -1);
  assert.equal(engine.compareVersions('2.0.0-1', '2.0.0-alpha'), -1);
  assert.equal(engine.compareVersions('1.34.1', '2.0.0-lab'), -1);
  assert.equal(engine.compareCore('2.0.0-lab', '2.0.0'), 0);
});

test('RED: the GitHub token goes to GitHub hosts only', () => {
  assert.equal(engine.tokenAllowedFor('https://raw.githubusercontent.com/TomSolid/x/main/.mypka/manifest.json'), true);
  assert.equal(engine.tokenAllowedFor('https://api.github.com/repos/a/b/contents/x'), true);
  assert.equal(engine.tokenAllowedFor('https://github.com/a/b'), true);
  assert.equal(engine.tokenAllowedFor('https://example.com/manifest.json'), false);
  assert.equal(engine.tokenAllowedFor('https://raw.githubusercontent.com.evil.test/x'), false);
  assert.equal(engine.tokenAllowedFor('https://user@evil.test/raw.githubusercontent.com'), false);
  assert.equal(engine.tokenAllowedFor('http://raw.githubusercontent.com/x'), false, 'never over plain http');
  assert.equal(engine.tokenAllowedFor('http://localhost:8000/manifest.json'), false);
});

test('parseRequires and parseImplements read exactly the two GL-1013 forms', () => {
  assert.deepEqual(engine.parseRequires('icor-concepts >=1 <2'), { lo: 1, hi: 2 });
  assert.equal(engine.parseRequires('icor-concepts ^1'), null);
  assert.equal(engine.parseImplements('icor-concepts/1'), 1);
  assert.equal(engine.parseImplements('icor-concepts/v1'), null);
});

/* A tiny in-memory vault for the units that need no lab. */
function memVault(files) {
  const dirs = new Set();
  for (const p of Object.keys(files)) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
  return {
    exists: async (p) => p in files || dirs.has(p),
    read: async (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
    readBinary: async (p) => Buffer.from(files[p]),
    listBases: async () => [], listAgentContracts: async () => [], listShims: async () => [], listScratchpads: async () => [],
  };
}

test('RED: a local manifest in the new map shape no longer crashes the three-way check', async () => {
  const remote = { schema: 1, version: '2.0.0', files: { 'a.md': sha('new') } };
  const local = { schema: 1, version: '2.0.0-lab', files: { 'a.md': sha('old'), '.icor-for-life/manifest.json': 'self' } };
  const r = await engine.runChecks({ fs: memVault({ 'a.md': 'old' }), hash, remote, local, installedVersion: '2.0.0-lab', agents: false, structure: false, hostLinks: false });
  const f = r.findings.find((x) => x.path === 'a.md');
  assert.ok(f && f.severity === 'attention' && f.message.includes('Changed upstream'));
});

test('without an installed manifest, `previous` tells a shipped older copy from an edit', async () => {
  const remote = { schema: 2, version: '1.1.0', files: { 'a.md': sha('v3'), 'b.md': sha('v3b') }, previous: { 'a.md': [sha('v1'), sha('v2')] } };
  const r = await engine.runChecks({ fs: memVault({ 'a.md': 'v2', 'b.md': 'mine' }), hash, remote, local: null, installedVersion: '1.0.0', agents: false, structure: false, hostLinks: false });
  const a = r.findings.find((x) => x.path === 'a.md');
  const b = r.findings.find((x) => x.path === 'b.md');
  assert.ok(a && a.severity === 'attention' && /older shipped version/.test(a.message) && /Safe/.test(a.action));
  assert.ok(b && b.severity === 'info' && b.message === 'You edited this file.');
});

test('a seed is reported only when missing ("add it"), never as changed', async () => {
  const remote = { schema: 1, version: '2.0.0', files: { '.obsidian/workspace.json': sha('shipped'), 'x.md': sha('x') }, seed: ['.obsidian/workspace.json'] };
  const changed = await engine.runChecks({ fs: memVault({ '.obsidian/workspace.json': '{"mine":1}', 'x.md': 'x' }), hash, remote, local: null, installedVersion: '2.0.0', agents: false, structure: false, hostLinks: false });
  assert.deepEqual(changed.findings, []);
  const gone = await engine.runChecks({ fs: memVault({ 'x.md': 'x' }), hash, remote, local: null, installedVersion: '2.0.0', agents: false, structure: false, hostLinks: false });
  assert.equal(gone.findings.length, 1);
  assert.ok(/Add it/.test(gone.findings[0].action));
});

test('the version folders\' descriptors are skipped; the concept schema and the example sources are not', async () => {
  const remote = { schema: 1, version: '1.0.0', files: {
    '.mypka/VERSION': sha('1.0.0\n'), '.mypka/CHANGELOG.md': sha('new'), '.mypka/README.md': sha('r'),
    '.mypka/icor-concepts-1.json': sha('{}'), '.mypka/sources.yaml.example': sha('ex'),
  } };
  const fs = memVault({ '.mypka/VERSION': '0.9.0\n', '.mypka/CHANGELOG.md': 'old', '.mypka/README.md': 'old', '.mypka/icor-concepts-1.json': '{"old":1}', '.mypka/sources.yaml.example': 'old' });
  const r = await engine.runChecks({ fs, hash, remote, local: null, installedVersion: '1.0.0', repo: 'mypka', metaDir: '.mypka', product: 'myPKA', agents: false, structure: false, hostLinks: false });
  const paths = r.findings.filter((f) => f.kind === 'file').map((f) => f.path).sort();
  assert.deepEqual(paths, ['.mypka/icor-concepts-1.json', '.mypka/sources.yaml.example']);
});

test('myPKA machine state is never drift: state/, sources.yaml, expansions/', () => {
  assert.ok(engine.isMachineState('.mypka/state/harness.json'));
  assert.ok(engine.isMachineState('.mypka/sources.yaml'));
  assert.ok(engine.isMachineState('.mypka/expansions/x/y.md'));
  assert.ok(!engine.isMachineState('.mypka/sources.yaml.example'));
  assert.ok(!engine.isHarnessPath('GEMINI.md'), 'GEMINI.md left the generated set with the split (b8y)');
});

/* ============================================================ the lab === */

const LAB = process.env.MYPKA_SPLIT_LAB || join(homedir(), 'Desktop', 'mypka-split-lab');
const SCAFFOLD = process.env.ICOR_SCAFFOLD_REPO || join(homedir(), 'projects', 'icor-for-life-scaffold');
const PRE_SPLIT_COMMIT = 'f7dd5f0';
const haveLab = existsSync(join(LAB, 'icor-for-life', '.icor-for-life', 'manifest.json')) && existsSync(join(LAB, 'mypka', '.mypka', 'manifest.json'));
let haveScaffold = false;
try { execFileSync('git', ['-C', SCAFFOLD, 'cat-file', '-e', PRE_SPLIT_COMMIT + '^{commit}'], { stdio: 'ignore' }); haveScaffold = true; } catch { haveScaffold = false; }
const labSkip = haveLab ? false : 'the split lab is not on this machine (' + LAB + ')';
const preSkip = haveLab && haveScaffold ? false : 'needs the lab and the scaffold repo at ' + PRE_SPLIT_COMMIT;

const scratch = haveLab ? mkdtempSync(join(tmpdir(), 'scaffold-check-split-')) : null;
test.after(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const noGit = (src) => !/(^|\/)\.git(\/|$)/.test(src.slice(LAB.length));

let seq = 0;
function copyInto(dst, ...roots) {
  mkdirSync(dst, { recursive: true });
  for (const r of roots) cpSync(join(LAB, r), dst, { recursive: true, verbatimSymlinks: true, filter: noGit });
  return dst;
}
/* A member install: the release zip ships the built plugins, the lab does
   not (SPLIT-LOG "not taken"). A stand-in manifest per missing plugin makes
   the fixture the shape a member has; the plugin check then has nothing to
   say, which is the truth about a real install. */
function plantPlugins(root) {
  const m = readJson(join(root, '.icor-for-life', 'manifest.json'));
  for (const id of m.plugins || []) {
    const p = join(root, '.obsidian', 'plugins', id, 'manifest.json');
    if (!existsSync(p)) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify({ id, version: '0.0.0' })); }
  }
  return root;
}
const fixtureA = () => plantPlugins(copyInto(join(scratch, 'A-' + (++seq)), 'icor-for-life', 'mypka'));

/* The 1.34.1 manifest, and the 2.0.0 history the ICOR builder writes at the
   cut: every path 1.34.1 shipped that ICOR 2.0.0 does not, as removed, with
   its 1.34.1 hash (build-scaffold-manifest.py, the "D" branch). */
const oldManifest = haveScaffold ? JSON.parse(execFileSync('git', ['-C', SCAFFOLD, 'show', PRE_SPLIT_COMMIT + ':.icor-for-life/manifest.json'], { encoding: 'utf8', maxBuffer: 1 << 26 })) : null;
function icorRemote() {
  const m = readJson(join(LAB, 'icor-for-life', '.icor-for-life', 'manifest.json'));
  if (oldManifest) {
    const removed = oldManifest.files.filter((f) => !(f.path in m.files)).map((f) => ({ path: f.path, sha256: f.sha256, note: '' }));
    m.history = [{ version: '2.0.0', date: '2026-10-01', removed, renamed: [], added: [] }];
  } else {
    const penn = '06 AI Team/Agents/Penn/AGENT.md';
    m.history = [{ version: '2.0.0', date: '2026-10-01', removed: [{ path: penn, sha256: sha(readFileSync(join(LAB, 'mypka', penn))), note: '' }], renamed: [], added: [] }];
  }
  return m;
}
const mypkaRemote = () => readJson(join(LAB, 'mypka', '.mypka', 'manifest.json'));
const run = (root, extra = {}) => engine.runSuite(Object.assign({ fs: diskVault(root), hash, configDir: '.obsidian', icorRemote: icorRemote(), mypkaRemote: mypkaRemote(), mypkaUrlSet: true }, extra));
const by = (r, pred) => r.findings.filter(pred);
const show = (fs) => fs.map((f) => f.repo + ' ' + f.severity + ' ' + f.kind + ' ' + f.path + ' :: ' + f.message).join('\n');

test('CRITICAL, mode A: no path myPKA ships is ever a leftover, under the real 2.0.0 history', { skip: labSkip }, async () => {
  const remote = icorRemote();
  const removed = remote.history[0].removed.map((x) => x.path);
  assert.ok(removed.includes('06 AI Team/Agents/Penn/AGENT.md'), 'the history really removes Penn with its 1.34.1 hash');
  const r = await run(fixtureA(), { icorRemote: remote });
  assert.equal(r.mode.name, 'A');
  const mypkaPaths = new Set(Object.keys(mypkaRemote().files));
  const wrong = by(r, (f) => f.repo === 'icor' && (f.kind === 'leftover' || f.kind === 'collision') && mypkaPaths.has(f.path));
  assert.deepEqual(wrong, [], show(wrong));
  assert.equal(by(r, (f) => f.kind === 'leftover' && f.severity === 'attention').length, 0);
});

test('mode A: a planted real leftover (CLAUDE.md, the 1.34.1 bytes) is flagged, and it is the only one', { skip: preSkip }, async () => {
  const root = fixtureA();
  writeFileSync(join(root, 'CLAUDE.md'), execFileSync('git', ['-C', SCAFFOLD, 'show', PRE_SPLIT_COMMIT + ':CLAUDE.md']));
  const r = await run(root);
  const left = by(r, (f) => f.kind === 'leftover' && f.severity === 'attention');
  assert.deepEqual(left.map((f) => f.path), ['CLAUDE.md'], show(left));
  assert.equal(left[0].repo, 'icor');
});

test('mode A clean: zero broken, zero attention, agents read from the myPKA manifest', { skip: labSkip }, async () => {
  const r = await run(fixtureA());
  const bad = by(r, (f) => f.severity !== 'info');
  assert.deepEqual(bad, [], show(bad));
  assert.equal(r.health, 'ok');
  assert.ok(!r.findings.some((f) => /predates agent identities/.test(f.message)), 'myPKA ships agents; the check reads them');
  assert.ok(!r.findings.some((f) => /undefined/.test(f.message)));
  assert.equal(r.sections.icor.latestVersion, '2.0.0-lab');
  assert.equal(r.sections.mypka.installedVersion, '1.0.0-lab');
});

test('mode A: a planted icor-concepts/2 in the installed ICOR manifest is one broken compatibility finding', { skip: labSkip }, async () => {
  const root = fixtureA();
  const p = join(root, '.icor-for-life', 'manifest.json');
  const m = readJson(p); m.implements = 'icor-concepts/2'; writeFileSync(p, JSON.stringify(m, null, 2));
  const r = await run(root);
  const broken = by(r, (f) => f.severity === 'broken');
  assert.equal(broken.length, 1, show(broken));
  assert.equal(broken[0].kind, 'compat');
  assert.ok(broken[0].message.includes('E_SCHEMA_MISMATCH'));
});

test('mode A: the latest ICOR outside the installed myPKA range says update myPKA first', { skip: labSkip }, async () => {
  const remote = icorRemote(); remote.implements = 'icor-concepts/2';
  const r = await run(fixtureA(), { icorRemote: remote });
  const att = by(r, (f) => f.severity === 'attention');
  assert.equal(att.length, 1, show(att));
  assert.ok(/Update myPKA before ICOR for Life/.test(att[0].action));
});

test('mode A: one planted .update file is exactly one attention finding', { skip: labSkip }, async () => {
  const root = fixtureA();
  writeFileSync(join(root, 'AGENTS.md.update'), 'the next version\n');
  const r = await run(root);
  const att = by(r, (f) => f.severity === 'attention');
  assert.equal(att.length, 1, show(att));
  assert.equal(att[0].kind, 'update');
  assert.equal(att[0].repo, 'mypka');
});

test('mode B, content vault: the myPKA side is one info line, "team lives elsewhere", never missing', { skip: labSkip }, async () => {
  const root = plantPlugins(copyInto(join(scratch, 'Bc-' + (++seq)), 'icor-for-life'));
  const r = await run(root);
  assert.equal(r.mode.name, 'B-content');
  const mine = by(r, (f) => f.repo === 'mypka');
  assert.equal(mine.length, 1, show(mine));
  assert.equal(mine[0].severity, 'info');
  assert.equal(mine[0].message, engine.TEAM_ELSEWHERE);
  assert.ok(/lives in its own folder/.test(mine[0].message) && !/missing/i.test(mine[0].message.replace('Nothing is missing', '')));
  assert.equal(r.sections.mypka.status, 'elsewhere');
  const h = await engine.loadHarness(diskVault(root), { teamHere: false });
  assert.equal(h.status, 'elsewhere');
  assert.ok(engine.renderHarness(h).join('\n').includes('team lives elsewhere'));
});

test('mode B, team folder opened as a vault: the ICOR side is one info line, "content lives elsewhere"', { skip: labSkip }, async () => {
  const root = copyInto(join(scratch, 'Bt-' + (++seq)), 'mypka');
  const r = await run(root);
  assert.equal(r.mode.name, 'B-team');
  const mine = by(r, (f) => f.repo === 'icor');
  assert.equal(mine.length, 1, show(mine));
  assert.equal(mine[0].severity, 'info');
  assert.ok(/content lives elsewhere/i.test(mine[0].message));
  assert.equal(await engine.historyWritable(diskVault(root)), false, 'no `.icor-for-life/` is ever created in a team folder');
});

test('mode A over Obsidian Sync (no dot folders): one Sync line per product, no dot path missing', { skip: labSkip }, async () => {
  const root = fixtureA();
  for (const d of ['.icor-for-life', '.mypka', '.claude', '.codex', '.gemini', '.agents', '.mcp.json', '.github', '.gitignore']) rmSync(join(root, d), { recursive: true, force: true });
  const r = await run(root);
  assert.equal(r.mode.name, 'A');
  for (const repo of ['icor', 'mypka']) {
    const sync = by(r, (f) => f.repo === repo && f.kind === 'sync');
    assert.equal(sync.length, 1, repo + ':\n' + show(sync));
    assert.ok(/Obsidian Sync does not carry dot folders/.test(sync[0].message));
  }
  const dotMissing = by(r, (f) => f.path.startsWith('.') && !f.path.startsWith('.obsidian/') && f.severity !== 'info');
  assert.deepEqual(dotMissing, [], show(dotMissing));
});

test('pre-split 1.34.1 against the new remotes: no throw, and CLAUDE.md and GEMINI.md are the only leftovers', { skip: preSkip }, async () => {
  const root = join(scratch, 'pre-' + (++seq));
  mkdirSync(root, { recursive: true });
  execFileSync('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', SCAFFOLD, PRE_SPLIT_COMMIT, root]);
  const r = await run(root);
  assert.equal(r.mode.name, 'A');
  assert.equal(r.mode.preSplit, true);
  const left = by(r, (f) => f.kind === 'leftover' && f.severity === 'attention').map((f) => f.path).sort();
  assert.deepEqual(left, ['CLAUDE.md', 'GEMINI.md']);
  assert.ok(by(r, (f) => f.repo === 'mypka' && f.kind === 'mode' && /before the split/.test(f.message)).length === 1);
  assert.deepEqual(by(r, (f) => f.kind === 'sync'), [], 'a vault that predates `.mypka/` is not a Sync device');
  assert.deepEqual(by(r, (f) => f.repo === 'mypka' && f.kind === 'version'), [], 'the old ICOR manifest is the record of files, never a myPKA version');
  assert.equal(r.mypkaInstalledVersion, null);
  assert.deepEqual(by(r, (f) => f.path.startsWith('.mypka/') && f.severity !== 'info'), [], 'the pre-split line already says to install `.mypka/`');
  assert.ok(!r.findings.some((f) => /undefined/.test(f.message)));
  const pennMissing = by(r, (f) => f.path === '06 AI Team/Agents/Penn/AGENT.md' && f.severity !== 'info');
  assert.deepEqual(pennMissing, []);
});

test('pre-split: a deleted example note is still known as one from the installed 1.34.1 manifest', { skip: preSkip }, async () => {
  const root = join(scratch, 'pre-' + (++seq));
  mkdirSync(root, { recursive: true });
  execFileSync('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', SCAFFOLD, PRE_SPLIT_COMMIT, root]);
  const example = '04 Inner World/Contacts/People/Alex Rivera.md';
  rmSync(join(root, example));
  /* The fallback lives in the local manifest's list flags; the remote has none. */
  const localFlags = readJson(join(root, '.icor-for-life', 'manifest.json'));
  const remote = icorRemote();
  remote.examples = localFlags.files.filter((f) => f.example).map((f) => f.path);
  const r = await run(root, { icorRemote: remote });
  assert.ok(!r.findings.some((f) => f.path === example), 'an example note is meant to be deleted');
});

test('no myPKA URL yet: the 2.0.0 removals are not judged, one line says why, nothing is offline', { skip: preSkip }, async () => {
  const root = fixtureA();
  writeFileSync(join(root, 'CLAUDE.md'), execFileSync('git', ['-C', SCAFFOLD, 'show', PRE_SPLIT_COMMIT + ':CLAUDE.md']));
  const r = await run(root, { mypkaRemote: null, mypkaUrlSet: false });
  assert.equal(by(r, (f) => f.kind === 'leftover' && f.severity === 'attention').length, 0);
  const why = by(r, (f) => f.repo === 'icor' && f.kind === 'leftover' && f.severity === 'info');
  assert.equal(why.length, 1, show(why));
  assert.ok(/not judged/.test(why[0].message));
  const notChecked = by(r, (f) => f.repo === 'mypka');
  assert.equal(notChecked.length, 1);
  assert.ok(/no myPKA manifest URL/.test(notChecked[0].message));
  assert.notEqual(r.health, 'offline');
});

test('a myPKA fetch that failed never turns the ICOR result offline; the bar shows the worse of the two', { skip: labSkip }, async () => {
  const r = await run(fixtureA(), { mypkaRemote: null, mypkaError: 'HTTP 404 fetching the latest manifest' });
  assert.equal(r.sections.icor.status, 'ok');
  assert.equal(r.sections.mypka.status, 'offline');
  assert.equal(r.health, 'offline');
});

test('schema 2 as Mack is adding it (moved_to, examples): the same answers', { skip: preSkip }, async () => {
  const icor = icorRemote(); const mypka = mypkaRemote();
  icor.schema = 2; mypka.schema = 2;
  for (const x of icor.history[0].removed) if (x.path in mypka.files) x.moved_to = 'mypka';
  icor.examples = oldManifest.files.filter((f) => f.example && f.path in icor.files).map((f) => f.path);
  const root = fixtureA();
  writeFileSync(join(root, 'CLAUDE.md'), execFileSync('git', ['-C', SCAFFOLD, 'show', PRE_SPLIT_COMMIT + ':CLAUDE.md']));
  rmSync(join(root, icor.examples[0]));
  const r = await run(root, { icorRemote: icor, mypkaRemote: mypka });
  const att = by(r, (f) => f.severity !== 'info');
  assert.deepEqual(att.map((f) => f.path), ['CLAUDE.md'], show(att));
  /* and with no myPKA manifest at all, moved_to alone keeps the team files out */
  const r2 = await run(root, { icorRemote: icor, mypkaRemote: null, mypkaUrlSet: false });
  assert.equal(by(r2, (f) => f.kind === 'leftover' && f.severity === 'attention').length, 0);
});

test('mode A: a deleted ICOR guideline reads "Canonical guideline is missing" in the ICOR section', { skip: labSkip }, async () => {
  const root = fixtureA();
  const gl = Object.keys(icorRemote().files).find((p) => p.includes('/Guidelines/'));
  rmSync(join(root, gl));
  const r = await run(root);
  const f = r.findings.find((x) => x.path === gl);
  assert.ok(f && f.repo === 'icor' && f.message === 'Canonical guideline is missing.' && /ICOR for Life Scaffold/.test(f.action), show([f]));
});

test('the report carries two sections, the mode and both versions, with no em dash', { skip: labSkip }, async () => {
  const r = await run(fixtureA());
  const md = engine.renderReport(r, { now: new Date('2026-09-24T10:00:00Z'), manifestUrl: 'https://x.test/i.json', mypkaManifestUrl: 'https://x.test/m.json' });
  for (const s of ['mode: A', 'mypka_installed_version: 1.0.0-lab', 'mypka_latest_version: 1.0.0-lab', '## ICOR for Life (content)', '## myPKA (team)', 'Latest myPKA manifest: https://x.test/m.json', 'myPKA for the myPKA (team) section']) {
    assert.ok(md.includes(s), s);
  }
  assert.ok(!/[\u2013\u2014]/.test(md), 'no en or em dash in generated prose');
  const rec = engine.runRecord(r, null, new Date('2026-09-24T10:00:00Z'));
  assert.equal(rec.repos.mypka.installed, '1.0.0-lab');
  assert.equal(engine.parseHistory(JSON.stringify(engine.appendRun(engine.parseHistory(null), rec))).runs.length, 1, 'HISTORY_SCHEMA 1 still reads a record with repos');
});
