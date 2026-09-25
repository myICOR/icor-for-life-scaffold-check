/* THE SPLIT GATES (0.7.0).
 *
 * ICOR for Life Scaffold 2.0.0 hands the AI team to a second product, myPKA
 * 6.0.0. These tests run the engine against the final split lab (Flint's
 * spec, section 6), through a disk-backed vault that answers like the
 * desktop adapter, with the two lab manifests as the remotes. The lab is
 * pinned in this repo (test/fixtures/lab-6.0.0/, rebuilt only by
 * test/fixtures/build-lab-fixture.mjs), so the gate runs the same on every
 * machine and in CI, and never reads a live folder. Fixtures are written
 * into a scratch folder; nothing is written inside the repo.
 *   SC_MAIN  an alternate main.js, for the mutation runs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { diskVault } from './disk-vault.mjs';
import { labFile, labJson, materialize, provenance } from './lab-fixture.mjs';

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

/* The final split lab, pinned in this repo: ICOR for Life 2.0.0, myPKA
   6.0.0 and the pre-split Scaffold 1.34.1 (test/fixtures/lab-6.0.0/, the
   commits in its provenance.json). Nothing here reads a live folder, so a
   rebuilt lab can never change what this gate means. Fixtures are written
   into a scratch folder per test. */

const scratch = mkdtempSync(join(tmpdir(), 'scaffold-check-split-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const PENN = '06 AI Team/Agents/Penn/AGENT.md';
const RELEASE_GATE = '06 AI Team/AI Team Knowledge/Scripts/release-gate-red-tests.sh';
/* The three removals the ICOR for Life 2.0.0 changelog names ("Removed:"),
   in neither product: everything else that left ICOR at 2.0.0 moved to myPKA. */
const REMOVED_AT_SPLIT = [RELEASE_GATE, 'CLAUDE.md', 'GEMINI.md'];

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

let seq = 0;
const fresh = (tag) => join(scratch, tag + '-' + (++seq));
const icorRemote = () => labJson('icor-for-life', '.icor-for-life/manifest.json');
const mypkaRemote = () => labJson('mypka', '.mypka/manifest.json');
/* The real 2.0.0 history without its `moved_to` marks: the partition alone
   must keep every team file out (Flint item 1, CRITICAL). */
function icorRemoteUnmarked() {
  const m = icorRemote();
  for (const h of m.history) for (const r of h.removed || []) delete r.moved_to;
  return m;
}
/* A member install: the release zip ships the built plugins, the lab does
   not (SPLIT-LOG "not taken"). A stand-in manifest per plugin the latest
   ICOR for Life lists makes the fixture the shape a member has. */
function plantPlugins(root) {
  for (const id of icorRemote().plugins || []) {
    const p = join(root, '.obsidian', 'plugins', id, 'manifest.json');
    if (!existsSync(p)) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify({ id, version: '0.0.0' })); }
  }
  return root;
}
/* A: ICOR for Life 2.0.0 and myPKA 6.0.0, both current. */
const fixtureA = () => plantPlugins(materialize(fresh('A'), 'icor-for-life', 'mypka'));
/* M: a 1.34.1 vault after the first half of the documented update
   (README-myPKA "Coming from ICOR for Life 1.34 or earlier"): myPKA 6.0.0
   applied over it, ICOR for Life not updated yet. Mode A, ICOR installed
   1.34.1, so the 2.0.0 removals are live. */
const fixtureM = () => plantPlugins(materialize(fresh('M'), 'scaffold-1.34.1', 'mypka'));
/* pre-split: the 1.34.1 Scaffold as it was, no `.mypka/`. */
const fixturePre = () => materialize(fresh('pre'), 'scaffold-1.34.1');

const run = (root, extra = {}) => engine.runSuite(Object.assign({ fs: diskVault(root), hash, configDir: '.obsidian', icorRemote: icorRemote(), mypkaRemote: mypkaRemote(), mypkaUrlSet: true }, extra));
const by = (r, pred) => r.findings.filter(pred);
const show = (fs) => fs.map((f) => f.repo + ' ' + f.severity + ' ' + f.kind + ' ' + f.path + ' :: ' + f.message).join('\n');
const leftovers = (r) => by(r, (f) => f.kind === 'leftover' && f.severity === 'attention').map((f) => f.path).sort();

test('the pinned lab is the final one: ICOR for Life 2.0.0 and myPKA 6.0.0, schema 2', () => {
  const icor = icorRemote(); const mypka = mypkaRemote();
  assert.equal(icor.version, '2.0.0'); assert.equal(icor.schema, 2);
  assert.equal(mypka.version, '6.0.0'); assert.equal(mypka.schema, 2);
  assert.ok(icor.previous && mypka.previous && Array.isArray(icor.examples) && icor.examples.length > 0);
  assert.equal(icor.history[0].version, '2.0.0');
  assert.deepEqual(icor.history[0].removed.filter((r) => !r.moved_to).map((r) => r.path).sort(), REMOVED_AT_SPLIT);
  assert.equal(labJson('scaffold-1.34.1', '.icor-for-life/manifest.json').version, '1.34.1');
  for (const t of ['icor-for-life', 'mypka', 'scaffold-1.34.1']) assert.match(provenance.sources[t].commit, /^[0-9a-f]{40}$/);
});

test('CRITICAL, mode A on 1.34.1: no path myPKA ships is ever a leftover, by the partition alone (moved_to stripped)', async () => {
  const remote = icorRemoteUnmarked();
  const removed = remote.history[0].removed.map((x) => x.path);
  assert.ok(removed.includes(PENN), 'the 2.0.0 history really removes Penn');
  const r = await run(fixtureM(), { icorRemote: remote });
  assert.equal(r.mode.name, 'A');
  assert.equal(r.sections.icor.installedVersion, '1.34.1', 'the 2.0.0 removals are after the installed version, so they are live');
  const mypkaPaths = new Set(Object.keys(mypkaRemote().files));
  const wrong = by(r, (f) => f.repo === 'icor' && (f.kind === 'leftover' || f.kind === 'collision') && mypkaPaths.has(f.path));
  assert.deepEqual(wrong, [], show(wrong));
  assert.deepEqual(leftovers(r), REMOVED_AT_SPLIT);
});

test('(a) a 1.34.1 vault: the untouched CLAUDE.md and GEMINI.md are leftovers, and with the maintainer script the only ones', async () => {
  const r = await run(fixtureM());
  const left = by(r, (f) => f.kind === 'leftover' && f.severity === 'attention');
  assert.deepEqual(left.map((f) => f.path).sort(), REMOVED_AT_SPLIT, show(left));
  for (const f of left) { assert.equal(f.repo, 'icor'); assert.equal(f.since, '2.0.0'); }
  /* "A copy you edited stays yours" (the 2.0.0 changelog): not a leftover */
  const root = fixtureM();
  writeFileSync(join(root, 'CLAUDE.md'), '# my own rules\n');
  const r2 = await run(root);
  assert.deepEqual(leftovers(r2), [RELEASE_GATE, 'GEMINI.md']);
  const mine = by(r2, (f) => f.path === 'CLAUDE.md');
  assert.equal(mine.length, 1, show(mine));
  assert.equal(mine[0].kind, 'collision'); assert.equal(mine[0].severity, 'info');
});

test('(a) a 2.0.0 vault: a 1.34.1 CLAUDE.md is not reported, because the removal is in the installed version itself', async () => {
  /* The rule engine.test.mjs pins ("the same file on the installed version
     is NOT a leftover"). The old lab called itself 2.0.0-lab, which sorts
     below 2.0.0, so a CLAUDE.md planted there was a leftover; the final lab
     is 2.0.0. */
  const root = fixtureA();
  writeFileSync(join(root, 'CLAUDE.md'), labFile('scaffold-1.34.1', 'CLAUDE.md'));
  const r = await run(root);
  assert.equal(r.sections.icor.installedVersion, '2.0.0');
  assert.deepEqual(by(r, (f) => f.path === 'CLAUDE.md'), []);
  assert.equal(r.health, 'ok');
});

test('mode A clean: zero broken, zero attention, agents read from the myPKA manifest', async () => {
  const r = await run(fixtureA());
  const bad = by(r, (f) => f.severity !== 'info');
  assert.deepEqual(bad, [], show(bad));
  assert.equal(r.health, 'ok');
  assert.ok(!r.findings.some((f) => /predates agent identities/.test(f.message)), 'myPKA ships agents; the check reads them');
  assert.ok(!r.findings.some((f) => /undefined/.test(f.message)));
  assert.equal(r.sections.icor.latestVersion, '2.0.0');
  assert.equal(r.sections.icor.installedVersion, '2.0.0');
  assert.equal(r.sections.mypka.installedVersion, '6.0.0');
  assert.equal(r.sections.mypka.latestVersion, '6.0.0');
});

test('mode A: a planted icor-concepts/2 in the installed ICOR manifest is one broken compatibility finding', async () => {
  const root = fixtureA();
  const p = join(root, '.icor-for-life', 'manifest.json');
  const m = readJson(p); m.implements = 'icor-concepts/2'; writeFileSync(p, JSON.stringify(m, null, 2));
  const r = await run(root);
  const broken = by(r, (f) => f.severity === 'broken');
  assert.equal(broken.length, 1, show(broken));
  assert.equal(broken[0].kind, 'compat');
  assert.ok(broken[0].message.includes('E_SCHEMA_MISMATCH'));
});

test('mode A: the latest ICOR outside the installed myPKA range says update myPKA first', async () => {
  const remote = icorRemote(); remote.implements = 'icor-concepts/2';
  const r = await run(fixtureA(), { icorRemote: remote });
  const att = by(r, (f) => f.severity === 'attention');
  assert.equal(att.length, 1, show(att));
  assert.ok(/Update myPKA before ICOR for Life/.test(att[0].action));
});

test('mode A: one planted .update file is exactly one attention finding', async () => {
  const root = fixtureA();
  writeFileSync(join(root, 'AGENTS.md.update'), 'the next version\n');
  const r = await run(root);
  const att = by(r, (f) => f.severity === 'attention');
  assert.equal(att.length, 1, show(att));
  assert.equal(att[0].kind, 'update');
  assert.equal(att[0].repo, 'mypka');
});

/* myPKA 6.0.0 ships one entry in every agent's Journal to hold the folder
   open, under two names (`-first-entry.md`, `-<name>-hired.md`), and neither
   is an example or a seed. Beside the agent's own entries it is not missing. */
const JOURNAL = (name, file) => '06 AI Team/Agents/' + name + '/Journal/' + file;

test('RED: mode A, myPKA pass: a journal placeholder beside the agent\'s own entry is not missing; beside only the template it still is', async () => {
  const root = fixtureA();
  rmSync(join(root, JOURNAL('Penn', '2026-09-14-first-entry.md')));
  writeFileSync(join(root, JOURNAL('Penn', '2026-09-20-a-real-lesson.md')), '# A real lesson\n');
  rmSync(join(root, JOURNAL('Mason', '2026-09-22-mason-hired.md')));
  writeFileSync(join(root, JOURNAL('Mason', '2026-09-23-another-lesson.md')), '# Another lesson\n');
  rmSync(join(root, JOURNAL('Charta', '2026-09-14-first-entry.md')));
  const r = await run(root);
  const att = by(r, (f) => f.severity === 'attention');
  assert.equal(att.length, 1, show(att));
  assert.equal(att[0].path, JOURNAL('Charta', '2026-09-14-first-entry.md'), 'only the template left: still missing');
  assert.equal(att[0].repo, 'mypka');
  assert.ok(/latest myPKA/.test(att[0].action), 'copied from the product that ships it');
});

test('RED: one "Left out on purpose" list covers both passes, content and team', async () => {
  const root = fixtureA();
  const content = '04 Inner World/Journal/README.md';
  const team = JOURNAL('Charta', '2026-09-14-first-entry.md');
  rmSync(join(root, content));
  rmSync(join(root, team));
  const r = await run(root, { leftOut: [content, team] });
  const bad = by(r, (f) => f.severity !== 'info');
  assert.deepEqual(bad, [], show(bad));
  assert.equal(r.health, 'ok');
  const left = by(r, (f) => f.kind === 'left-out');
  assert.deepEqual(left.map((f) => f.repo + ' ' + f.path).sort(), ['icor ' + content, 'mypka ' + team]);
});

test('mode B, content vault: the myPKA side is one info line, "team lives elsewhere", never missing', async () => {
  const root = plantPlugins(materialize(fresh('Bc'), 'icor-for-life'));
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

test('mode B, team folder opened as a vault: the ICOR side is one info line, "content lives elsewhere"', async () => {
  const root = materialize(fresh('Bt'), 'mypka');
  const r = await run(root);
  assert.equal(r.mode.name, 'B-team');
  const mine = by(r, (f) => f.repo === 'icor');
  assert.equal(mine.length, 1, show(mine));
  assert.equal(mine[0].severity, 'info');
  assert.ok(/content lives elsewhere/i.test(mine[0].message));
  assert.equal(await engine.historyWritable(diskVault(root)), false, 'no `.icor-for-life/` is ever created in a team folder');
});

test('mode A over Obsidian Sync (no dot folders): one Sync line per product, no dot path missing', async () => {
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

test('pre-split 1.34.1 against the final remotes: no throw, and the 2.0.0 removals are the only leftovers', async () => {
  const r = await run(fixturePre());
  assert.equal(r.mode.name, 'A');
  assert.equal(r.mode.preSplit, true);
  assert.deepEqual(leftovers(r), REMOVED_AT_SPLIT);
  assert.ok(by(r, (f) => f.repo === 'mypka' && f.kind === 'mode' && /before the split/.test(f.message)).length === 1);
  assert.deepEqual(by(r, (f) => f.kind === 'sync'), [], 'a vault that predates `.mypka/` is not a Sync device');
  assert.deepEqual(by(r, (f) => f.repo === 'mypka' && f.kind === 'version'), [], 'the old ICOR manifest is the record of files, never a myPKA version');
  assert.equal(r.mypkaInstalledVersion, null);
  assert.deepEqual(by(r, (f) => f.path.startsWith('.mypka/') && f.severity !== 'info'), [], 'the pre-split line already says to install `.mypka/`');
  assert.ok(!r.findings.some((f) => /undefined/.test(f.message)));
});

test('(c) pre-split: Penn changed between 1.34.1 and myPKA 6.0.0, so an untouched Penn is "safe to update", the same answer `previous` gives', async () => {
  const r = await run(fixturePre());
  const penn = by(r, (f) => f.path === PENN);
  assert.equal(penn.length, 1, show(penn));
  assert.equal(penn[0].repo, 'mypka');
  assert.equal(penn[0].severity, 'attention');
  assert.match(penn[0].message, /^Changed upstream since you installed; your copy is the version you started with\.$/);
  assert.match(penn[0].action, /Safe: you never edited it/);
  /* the same verdict mypka-update.py reaches: the 1.34.1 bytes are an older
     shipped state of the path, not an edit */
  const old = sha(labFile('scaffold-1.34.1', PENN));
  const m = mypkaRemote();
  assert.notEqual(m.files[PENN], old, 'Penn really changed');
  assert.ok(m.previous[PENN].includes(old), 'myPKA lists the 1.34.1 bytes as shipped');
  /* and with no borrowed 1.34.1 manifest at all, `previous` alone says the same */
  const alone = await engine.runChecks({ fs: diskVault(fixturePre()), hash, remote: m, local: null, installedVersion: null, repo: 'mypka', metaDir: '.mypka', product: 'myPKA', agents: false, structure: false, hostLinks: false, quietMissingVersion: true, metaNotInstalled: true });
  const p2 = alone.findings.find((f) => f.path === PENN);
  assert.ok(p2 && p2.severity === 'attention' && /older shipped version/.test(p2.message) && /Safe/.test(p2.action), show([p2]));
});

test('an example note the manifest lists is meant to be deleted: no finding', async () => {
  const icor = icorRemote();
  const example = '04 Inner World/Contacts/People/Alex Rivera.md';
  assert.ok(icor.examples.includes(example));
  const pre = fixturePre(); rmSync(join(pre, example));
  assert.ok(!(await run(pre)).findings.some((f) => f.path === example), 'pre-split');
  const a = fixtureA(); rmSync(join(a, icor.examples[0]));
  const r = await run(a);
  assert.deepEqual(by(r, (f) => f.severity !== 'info'), [], 'mode A');
});

test('(b) no myPKA URL yet, 1.34.1 vault: the 2.0.0 removals are not judged, one line says why, nothing is offline', async () => {
  const r = await run(fixtureM(), { mypkaRemote: null, mypkaUrlSet: false });
  assert.deepEqual(leftovers(r), []);
  const why = by(r, (f) => f.repo === 'icor' && f.kind === 'leftover' && f.severity === 'info');
  assert.equal(why.length, 1, show(why));
  assert.ok(/not judged/.test(why[0].message));
  /* moved_to keeps the 159 team files out; left: the three removals and
     the renamed noteio.py, which no entry says went anywhere */
  assert.match(why[0].message, /^4 files /);
  const notChecked = by(r, (f) => f.repo === 'mypka');
  assert.equal(notChecked.length, 1, show(notChecked));
  assert.ok(/no myPKA manifest URL/.test(notChecked[0].message));
  assert.notEqual(r.health, 'offline');
  /* without the marks, every 2.0.0 removal still here is held back, none judged */
  const r2 = await run(fixtureM(), { icorRemote: icorRemoteUnmarked(), mypkaRemote: null, mypkaUrlSet: false });
  assert.deepEqual(leftovers(r2), []);
  const why2 = by(r2, (f) => f.repo === 'icor' && f.kind === 'leftover' && f.severity === 'info');
  assert.equal(why2.length, 1, show(why2));
  assert.ok(Number(why2[0].message.split(' ')[0]) > 100, why2[0].message);
});

test('(b) no myPKA URL yet, 2.0.0 vault: nothing was removed after the installed version, so there is nothing to hold back and no line', async () => {
  const r = await run(fixtureA(), { mypkaRemote: null, mypkaUrlSet: false });
  assert.deepEqual(by(r, (f) => f.kind === 'leftover'), []);
  assert.equal(by(r, (f) => f.repo === 'mypka').length, 1);
});

test('a myPKA fetch that failed never turns the ICOR result offline; the bar shows the worse of the two', async () => {
  const r = await run(fixtureA(), { mypkaRemote: null, mypkaError: 'HTTP 404 fetching the latest manifest' });
  assert.equal(r.sections.icor.status, 'ok');
  assert.equal(r.sections.mypka.status, 'offline');
  assert.equal(r.health, 'offline');
});

test('mode A: a deleted ICOR guideline reads "Canonical guideline is missing" in the ICOR section', async () => {
  const root = fixtureA();
  const gl = Object.keys(icorRemote().files).find((p) => p.includes('/Guidelines/'));
  rmSync(join(root, gl));
  const r = await run(root);
  const f = r.findings.find((x) => x.path === gl);
  assert.ok(f && f.repo === 'icor' && f.message === 'Canonical guideline is missing.' && /ICOR for Life Scaffold/.test(f.action), show([f]));
});

test('the report carries two sections, the mode and both versions, with no em dash', async () => {
  const r = await run(fixtureA());
  const md = engine.renderReport(r, { now: new Date('2026-09-24T10:00:00Z'), manifestUrl: 'https://x.test/i.json', mypkaManifestUrl: 'https://x.test/m.json' });
  for (const s of ['mode: A', 'mypka_installed_version: 6.0.0', 'mypka_latest_version: 6.0.0', '## ICOR for Life (content)', '## myPKA (team)', 'Latest myPKA manifest: https://x.test/m.json', 'myPKA for the myPKA (team) section']) {
    assert.ok(md.includes(s), s);
  }
  assert.ok(!/[\u2013\u2014]/.test(md), 'no en or em dash in generated prose');
  const rec = engine.runRecord(r, null, new Date('2026-09-24T10:00:00Z'));
  assert.equal(rec.repos.mypka.installed, '6.0.0');
  assert.equal(engine.parseHistory(JSON.stringify(engine.appendRun(engine.parseHistory(null), rec))).runs.length, 1, 'HISTORY_SCHEMA 1 still reads a record with repos');
});
