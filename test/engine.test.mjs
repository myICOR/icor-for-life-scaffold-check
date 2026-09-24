/* THE ENGINE GATES.
 *
 * The check engine is pure: it takes a vault as an interface and returns
 * findings. These tests build in-memory vaults that carry each defect the
 * plugin exists to find, and assert it is found; and they build a clean vault
 * and assert nothing is invented. GL-005 rule 4: every guard is watched going
 * red before it is trusted, so the red cases come first.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { engine } = require('../main.js');

const sha = (s) => createHash('sha256').update(s).digest('hex');
const hash = async (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');

/* An in-memory vault: files is path -> string; folders are inferred from
   file paths plus an explicit list, so an empty required folder can exist. */
function vault(files, folders = [], links = null) {
  const dirs = new Set(folders);
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    exists: async (p) => p in files || dirs.has(p),
    read: async (p) => { if (!(p in files)) throw new Error('ENOENT ' + p); return files[p]; },
    readBinary: async (p) => Buffer.from(files[p]),
    listBases: async () => Object.keys(files).filter((p) => p.endsWith('.base') && !p.startsWith('.obsidian/')),
    listAgentContracts: async () => Object.keys(files).filter((p) => /^06 AI Team\/Agents\/[^/]+\/AGENT\.md$/.test(p)),
    listShims: async () => Object.keys(files).filter((p) => /^\.claude\/agents\/[^/]+\.md$/.test(p)),
    listScratchpads: async () => Object.keys(files).filter((p) => p.startsWith('00 Daily Scratchpad/')),
    listSkillNames: async () => Object.keys(files)
      .map((p) => /^06 AI Team\/AI Team Knowledge\/Skills\/([^/]+)\/SKILL\.md$/.exec(p))
      .filter(Boolean).map((m) => m[1]),
    /* The real adapter's shape, simulated rather than hand-written, so a
       test cannot assert a shape the adapter never produces. `links`
       describes the DISK: `mobile` answers before reading anything,
       `present` says the folder is there, `resolved` names the links that
       have a skill behind them, `listed` names what a listing would return,
       and `listable: false` is a listing that rejected, which is what a
       dangling link does on desktop. */
    hostSkillLinks: async (names) => {
      const L = links || {};
      if (L.mobile) return { supported: false, present: false, entries: [] };
      if (!L.present) return { supported: true, present: false, entries: [] };
      const resolved = new Set(L.resolved || []);
      const entries = [], seen = new Set();
      for (const name of names || []) { if (seen.has(name)) continue; seen.add(name); entries.push({ name, resolves: resolved.has(name), known: true }); }
      if (L.listable === false) return { supported: true, present: true, listable: false, entries };
      for (const name of L.listed || []) { if (seen.has(name)) continue; seen.add(name); entries.push({ name, resolves: resolved.has(name), known: false }); }
      return { supported: true, present: true, listable: true, entries };
    },
  };
}

const GL006 = '---\ntype: guideline\n---\n# GL-006\n';
const README = '# ICOR for Life Scaffold\n';

/* The nine shipped agents' real ids (scaffold 1.11.0); three are enough. */
const ID = { penn: 'd40ec637-e612-4baf-987c-a3ebb71a1536', larry: '9a23e8a4-8d9f-4893-bd91-0950f26015c9', pax: '7cb91c69-150c-46f0-ad78-eb2f7a220b80' };
const NIL = '00000000-0000-0000-0000-000000000000';
const PENN_PATH = '06 AI Team/Agents/Penn/AGENT.md';
const PENN_SHIM = '.claude/agents/penn.md';
const contract = (name, id, extra = '') => '---\ntype: agent\n' + (id === undefined ? '' : 'myicor_id: ' + id + '\n') + 'name: ' + name + '\n' + extra + '---\n# ' + name + '\n';
const shim = (path) => '---\nname: x\n---\nYour canonical contract is `' + path + '` at the vault root.\n';
const PENN = contract('Penn', ID.penn);
const PENN_SHIM_TEXT = shim(PENN_PATH);

function remoteManifest(extra = {}) {
  return Object.assign({
    schema: 1, version: '1.5.0', rooms: ['04 Inner World/Journal', '06 AI Team/Agents'],
    plugins: ['icor-for-life-connect'], snippets: [],
    files: [
      { path: 'README.md', sha256: sha(README), kind: 'doc', example: false },
      { path: '06 AI Team/AI Team Knowledge/Guidelines/GL-006-bases-and-live-views.md', sha256: sha(GL006), kind: 'guideline', example: false },
      { path: '04 Inner World/Contacts/People/Alex Rivera.md', sha256: sha('example'), kind: 'doc', example: true },
      { path: PENN_PATH, sha256: sha(PENN), kind: 'agent', example: false },
      { path: PENN_SHIM, sha256: sha(PENN_SHIM_TEXT), kind: 'shim', example: false },
    ],
    agents: [{ name: 'Penn', myicor_id: ID.penn, path: PENN_PATH, shim: PENN_SHIM }],
    bases: [],
    history: [
      { version: '1.5.0', date: '2026-09-01', removed: [{ path: '.obsidian/snippets/icor-rooms.css', note: 'moved into the theme' }], renamed: [], added: [] },
      { version: '1.4.2', date: '2026-08-30', removed: [], renamed: [], added: ['.obsidian/workspace.json'] },
    ],
  }, extra);
}

const cleanFiles = () => ({
  'README.md': README,
  '06 AI Team/AI Team Knowledge/Guidelines/GL-006-bases-and-live-views.md': GL006,
  [PENN_PATH]: PENN,
  [PENN_SHIM]: PENN_SHIM_TEXT,
  '.icor-for-life/VERSION': '1.5.0\n',
  '.obsidian/community-plugins.json': '["icor-for-life-connect"]',
  '.obsidian/plugins/icor-for-life-connect/manifest.json': '{}',
  '.obsidian/appearance.json': '{"enabledCssSnippets":[]}',
});
const cleanFolders = ['04 Inner World/Journal', '06 AI Team/Agents'];

/* ------------------------------------------------------------- RED ---- */

test('RED: a missing required folder is broken', async () => {
  const r = await engine.runChecks({ fs: vault(cleanFiles(), ['06 AI Team/Agents']), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  assert.equal(r.health, 'broken');
  assert.ok(r.findings.some((f) => f.kind === 'room' && f.path === '04 Inner World/Journal'));
});

test('RED: a Base filtering on a folder that does not exist is broken', async () => {
  const files = cleanFiles();
  files['03 WiP/Deliverables.base'] = 'filters:\n  and:\n    - file.inFolder("OUTPUT")\n';
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  assert.equal(r.health, 'broken');
  const f = r.findings.find((x) => x.kind === 'base');
  assert.ok(f && f.message.includes('OUTPUT'));
});

test('RED: a leftover removed upstream after the installed version is found, with its changelog note', async () => {
  const files = cleanFiles();
  files['.icor-for-life/VERSION'] = '1.4.2\n';
  files['.obsidian/snippets/icor-rooms.css'] = '/* old */';
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.4.2' });
  const f = r.findings.find((x) => x.kind === 'leftover');
  assert.ok(f, 'leftover not found');
  assert.equal(f.since, '1.5.0');
  assert.ok(f.message.includes('moved into the theme'));
  assert.equal(r.health, 'attention');
});

test('RED: the same file on the installed version is NOT a leftover', async () => {
  const files = cleanFiles();
  files['.obsidian/snippets/icor-rooms.css'] = '/* current */';
  const remote = remoteManifest({ version: '1.4.2', history: [{ version: '1.4.2', date: '2026-08-30', removed: [{ path: '.obsidian/snippets/icor-rooms.css', note: 'x' }], renamed: [], added: [] }] });
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote, local: null, installedVersion: '1.4.2' });
  assert.ok(!r.findings.some((x) => x.kind === 'leftover'), 'a removal in the installed version itself must not count');
});

test('RED: the scaffold\'s OLD bytes under a renamed path are a leftover; the user\'s own file under that name is not', async () => {
  const OLD_GL = '---\nid: GL-001\n---\n# The six rooms (scaffold, old)\n';
  const remote = remoteManifest({ history: [
    { version: '1.5.0', date: '2026-09-01', removed: [], added: [], renamed: [
      { from: '06 AI Team/AI Team Knowledge/Guidelines/GL-001-the-six-rooms.md', to: '06 AI Team/AI Team Knowledge/Guidelines/GL-1001-the-six-rooms.md', from_sha256: sha(OLD_GL) },
    ] },
  ] });
  /* a) the member still has the scaffold's old GL-001, byte for byte */
  let files = cleanFiles(); files['.icor-for-life/VERSION'] = '1.4.2\n';
  files['06 AI Team/AI Team Knowledge/Guidelines/GL-001-the-six-rooms.md'] = OLD_GL;
  let r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote, local: null, installedVersion: '1.4.2' });
  let f = r.findings.find((x) => x.path.endsWith('GL-001-the-six-rooms.md'));
  assert.ok(f && f.kind === 'leftover' && f.message.includes('renamed to'), 'old scaffold bytes must be a leftover');
  /* b) the member's OWN GL-001 with the same name: theirs, a collision, never a leftover */
  files = cleanFiles(); files['.icor-for-life/VERSION'] = '1.4.2\n';
  files['06 AI Team/AI Team Knowledge/Guidelines/GL-001-the-six-rooms.md'] = '---\nid: GL-001\n---\n# My own naming guideline\n';
  r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote, local: null, installedVersion: '1.4.2' });
  f = r.findings.find((x) => x.path.endsWith('GL-001-the-six-rooms.md'));
  assert.ok(f && f.kind === 'collision' && f.severity === 'info', 'the user\'s own file must be a collision, not a leftover');
  assert.ok(!r.findings.some((x) => x.kind === 'leftover'));
  /* the only attention item a 1.4.2 vault may carry here is the version gap itself */
  assert.ok(r.findings.filter((x) => x.severity === 'attention').every((x) => x.kind === 'version'));
});

test('RED: a removed file with no hash in the manifest still matches by name (older manifests)', async () => {
  const files = cleanFiles(); files['.icor-for-life/VERSION'] = '1.4.2\n'; files['.obsidian/snippets/icor-rooms.css'] = 'anything';
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.4.2' });
  assert.ok(r.findings.some((x) => x.kind === 'leftover'));
});

test('RED: a snippet enabled in appearance.json but gone from disk is attention', async () => {
  const files = cleanFiles();
  files['.obsidian/appearance.json'] = '{"enabledCssSnippets":["icor-rooms"]}';
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  assert.ok(r.findings.some((x) => x.kind === 'snippet' && x.severity === 'attention'));
});

test('RED: an expected plugin that is installed but not enabled is attention', async () => {
  const files = cleanFiles();
  files['.obsidian/community-plugins.json'] = '[]';
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  const f = r.findings.find((x) => x.kind === 'plugin');
  assert.ok(f && f.message.includes('not enabled'));
});

/* ----------------------------------------------------- three-way files -- */

test('three-way: missing canonical file is attention; a missing EXAMPLE note is not a finding', async () => {
  const files = cleanFiles();
  delete files['06 AI Team/AI Team Knowledge/Guidelines/GL-006-bases-and-live-views.md'];
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  const gl = r.findings.find((x) => x.kind === 'file' && x.path.endsWith('GL-006-bases-and-live-views.md'));
  assert.ok(gl && gl.severity === 'attention');
  assert.ok(!r.findings.some((x) => x.path.endsWith('Alex Rivera.md')), 'example notes are meant to be deleted');
});

test('three-way: changed upstream, untouched by the user, is attention (safe to update)', async () => {
  const files = cleanFiles();
  files['README.md'] = 'old readme';
  const local = { version: '1.4.2', files: [{ path: 'README.md', sha256: sha('old readme') }] };
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local, installedVersion: '1.4.2' });
  const f = r.findings.find((x) => x.kind === 'file' && x.path === 'README.md');
  assert.ok(f && f.severity === 'attention' && f.message.includes('Changed upstream'));
});

test('three-way: edited by the user is info and says keep it', async () => {
  const files = cleanFiles();
  files['README.md'] = 'my own readme';
  const local = { version: '1.5.0', files: [{ path: 'README.md', sha256: sha(README) }] };
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local, installedVersion: '1.5.0' });
  const f = r.findings.find((x) => x.kind === 'file' && x.path === 'README.md');
  assert.ok(f && f.severity === 'info' && /Keep/.test(f.action));
  assert.equal(r.health, 'ok', 'a user edit alone must not lower health');
});

test('three-way: edited by the user AND changed upstream is info, never overwrite', async () => {
  const files = cleanFiles();
  files['README.md'] = 'my own readme';
  const local = { version: '1.4.2', files: [{ path: 'README.md', sha256: sha('old readme') }] };
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local, installedVersion: '1.4.2' });
  const f = r.findings.find((x) => x.kind === 'file' && x.path === 'README.md');
  assert.ok(f && f.severity === 'info' && f.message.includes('also changed upstream'));
});

/* -------------------------------------------------------------- GREEN -- */

test('GREEN: a clean vault on the latest version is ok with no findings', async () => {
  const r = await engine.runChecks({ fs: vault(cleanFiles(), cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  assert.equal(r.health, 'ok');
  assert.deepEqual(r.findings, []);
});

test('GREEN: files the scaffold never shipped are not drift', async () => {
  const files = cleanFiles();
  for (let i = 0; i < 60; i++) files['06 AI Team/AI Team Knowledge/Guidelines/GL-0' + (10 + i) + '-mine.md'] = 'mine';
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  assert.equal(r.health, 'ok');
  assert.equal(r.findings.length, 0);
});

test('an older installed version is attention with the gap named', async () => {
  const files = cleanFiles(); files['.icor-for-life/VERSION'] = '1.4.2\n';
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.4.2' });
  const f = r.findings.find((x) => x.kind === 'version');
  assert.ok(f && f.severity === 'attention' && f.message.includes('1.4.2') && f.message.includes('1.5.0'));
});

test('no installed version at all is info, and every historical removal counts', async () => {
  const files = cleanFiles(); delete files['.icor-for-life/VERSION'];
  files['.obsidian/snippets/icor-rooms.css'] = '';
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: null });
  assert.ok(r.findings.some((x) => x.kind === 'version' && x.severity === 'info'));
  assert.ok(r.findings.some((x) => x.kind === 'leftover'));
});

test('a manifest that is not a scaffold manifest is refused, not silently green', async () => {
  await assert.rejects(() => engine.runChecks({ fs: vault(cleanFiles(), cleanFolders), hash, remote: { hello: 'world' }, local: null, installedVersion: null }));
});

/* ------------------------------------------------------------ helpers -- */

test('compareVersions orders semver numerically and refuses garbage', () => {
  assert.equal(engine.compareVersions('1.4.2', '1.5.0'), -1);
  assert.equal(engine.compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(engine.compareVersions('1.5.0', '1.5.0'), 0);
  assert.equal(engine.compareVersions('latest', '1.5.0'), null);
});

test('baseFolders reads every inFolder filter once', () => {
  assert.deepEqual(engine.baseFolders('- file.inFolder("03 WiP")\n- file.inFolder("03 WiP")\n- file.inFolder("04 Inner World/Journal")'), ['03 WiP', '04 Inner World/Journal']);
});

test('renderReport carries the numbers in frontmatter and every finding in the body', async () => {
  const files = cleanFiles(); files['.icor-for-life/VERSION'] = '1.4.2\n'; files['.obsidian/snippets/icor-rooms.css'] = '';
  const r = await engine.runChecks({ fs: vault(files, ['06 AI Team/Agents']), hash, remote: remoteManifest(), local: null, installedVersion: '1.4.2' });
  const md = engine.renderReport(r, { now: new Date('2026-09-01T10:00:00Z'), manifestUrl: 'https://example.test/m.json' });
  assert.ok(md.startsWith('---\ntype: scaffold-check\ndate: 2026-09-01\nhealth: broken\n'));
  assert.ok(md.includes('installed_version: 1.4.2'));
  assert.ok(md.includes('## Broken (1)'));
  assert.ok(md.includes('`04 Inner World/Journal`'));
  assert.ok(md.includes('`.obsidian/snippets/icor-rooms.css`'));
  assert.ok(md.includes('## For your AI'));
  assert.ok(!md.includes('—'), 'no em dashes in generated prose');
});

/* ------------------------------------------------- agent identities ---- */
/* Scaffold 1.11.0: every contract carries a stable `myicor_id`. The manifest
   names each shipped agent's id, so a renamed agent is found by identity,
   not by folder name. The red cases come first. */

const run = (files, opts = {}) => engine.runChecks(Object.assign({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' }, opts));
const agentFindings = (r) => r.findings.filter((x) => x.kind === 'agents');

test('RED 1c: the shipped agent at its canonical path with NO myicor_id is attention, with the fix, and reported once', async () => {
  const files = cleanFiles(); files[PENN_PATH] = contract('Penn', undefined);
  const r = await run(files);
  const a = agentFindings(r);
  assert.equal(a.length, 1, 'one finding for one defect, not one per rule');
  assert.equal(a[0].severity, 'attention');
  assert.equal(a[0].path, PENN_PATH);
  assert.ok(a[0].message.includes('Shipped agent Penn carries no myicor_id'));
  assert.ok(a[0].action.includes('mint-agent-ids.py --map'));
  assert.equal(r.health, 'attention');
});

test('RED 1c: a DIFFERENT id at the shipped agent\'s canonical path means the shipped one is missing', async () => {
  const files = cleanFiles(); files[PENN_PATH] = contract('Penn', ID.pax);
  const r = await run(files);
  const a = agentFindings(r);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'attention');
  assert.ok(a[0].message.includes('is a different agent than the shipped Penn'));
  assert.ok(a[0].message.includes('the shipped one is missing'));
});

test('RED 1b: the shipped agent found by id under another name is info, and neither the canonical contract nor its shim is reported missing', async () => {
  const files = cleanFiles();
  delete files[PENN_PATH]; delete files[PENN_SHIM];
  files['06 AI Team/Agents/Nancy/AGENT.md'] = contract('Nancy', ID.penn);
  files['.claude/agents/nancy.md'] = shim('06 AI Team/Agents/Nancy/AGENT.md');
  const r = await run(files);
  const a = agentFindings(r);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'info');
  assert.equal(a[0].path, '06 AI Team/Agents/Nancy/AGENT.md');
  assert.ok(a[0].message.includes('Shipped agent Penn lives at') && a[0].message.includes('Nancy') && a[0].message.includes('identity intact'));
  assert.ok(!r.findings.some((x) => x.kind === 'file' && x.path === PENN_PATH), 'the canonical path must not be reported missing');
  assert.ok(!r.findings.some((x) => x.kind === 'file' && x.path === PENN_SHIM), 'the shim at another slug must not be reported missing');
  assert.equal(r.health, 'ok');
});

test('RED 1b: renamed agent, but the shim is gone everywhere: the shim IS still reported missing', async () => {
  const files = cleanFiles();
  delete files[PENN_PATH]; delete files[PENN_SHIM];
  files['06 AI Team/Agents/Nancy/AGENT.md'] = contract('Nancy', ID.penn);
  const r = await run(files);
  assert.ok(!r.findings.some((x) => x.kind === 'file' && x.path === PENN_PATH));
  assert.ok(r.findings.some((x) => x.kind === 'file' && x.path === PENN_SHIM && x.severity === 'attention'));
});

test('RED 1d: a shipped agent found nowhere is the existing missing-file finding, and nothing else', async () => {
  const files = cleanFiles(); delete files[PENN_PATH];
  const r = await run(files);
  const f = r.findings.find((x) => x.kind === 'file' && x.path === PENN_PATH);
  assert.ok(f && f.severity === 'attention' && f.message.includes('missing'));
  assert.equal(agentFindings(r).length, 0);
});

test('RED 1a: the shipped agent at its canonical path with its id is no identity finding; the file rules alone apply', async () => {
  const files = cleanFiles(); files[PENN_PATH] = PENN + '\nMy own addition.\n';
  const local = { version: '1.5.0', files: [{ path: PENN_PATH, sha256: sha(PENN) }] };
  const r = await run(files, { local });
  assert.equal(agentFindings(r).length, 0);
  const f = r.findings.find((x) => x.kind === 'file' && x.path === PENN_PATH);
  assert.ok(f && f.severity === 'info' && f.message.includes('You edited'));
});

test('RED 2: the member\'s own contract with no myicor_id is attention with the fix', async () => {
  const files = cleanFiles(); files['06 AI Team/Agents/Kaspar/AGENT.md'] = contract('Kaspar', undefined);
  const r = await run(files);
  const a = agentFindings(r);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'attention');
  assert.equal(a[0].path, '06 AI Team/Agents/Kaspar/AGENT.md');
  assert.ok(a[0].message.includes('no myicor_id'));
  assert.ok(a[0].action.includes('mint-agent-ids.py'));
});

test('RED 2: a malformed id (not a lowercase UUID v4) is attention', async () => {
  for (const bad of ['D40EC637-E612-4BAF-987C-A3EBB71A1536', 'd40ec637-e612-1baf-987c-a3ebb71a1536', 'kaspar-1', '"d40ec637-e612-4baf-987c-a3ebb71a153"']) {
    const files = cleanFiles(); files['06 AI Team/Agents/Kaspar/AGENT.md'] = contract('Kaspar', bad);
    const r = await run(files);
    const a = agentFindings(r);
    assert.equal(a.length, 1, 'malformed ' + bad);
    assert.equal(a[0].severity, 'attention');
    assert.ok(a[0].message.includes('not a lowercase UUID v4'), bad);
  }
});

test('RED 2: the nil placeholder on a contract that is not a template is attention; on a template it is fine', async () => {
  const files = cleanFiles();
  files['06 AI Team/Agents/Kaspar/AGENT.md'] = contract('Kaspar', NIL);
  files['06 AI Team/Agents/Agent 01/AGENT.md'] = contract('Agent 01', NIL + '  # placeholder: the hiring SOP mints the real id');
  files['06 AI Team/Agents/_template/AGENT.md'] = contract('_template', NIL);
  const r = await run(files);
  const a = agentFindings(r);
  assert.equal(a.length, 1);
  assert.equal(a[0].path, '06 AI Team/Agents/Kaspar/AGENT.md');
  assert.equal(a[0].severity, 'attention');
  assert.ok(a[0].message.includes('placeholder'));
});

test('RED 2: two contracts sharing one id is broken, naming both paths, once', async () => {
  const files = cleanFiles();
  files['06 AI Team/Agents/Kaspar/AGENT.md'] = contract('Kaspar', ID.pax);
  files['06 AI Team/Agents/Vita/AGENT.md'] = contract('Vita', ID.pax);
  const r = await run(files);
  const a = agentFindings(r).filter((x) => x.severity === 'broken');
  assert.equal(a.length, 1);
  assert.ok(a[0].message.includes('06 AI Team/Agents/Kaspar/AGENT.md') && a[0].message.includes('06 AI Team/Agents/Vita/AGENT.md'));
  assert.ok(a[0].message.includes(ID.pax));
  assert.equal(r.health, 'broken');
});

test('RED 4: a manifest without `agents` skips identity matching, says so once, and still checks every local contract', async () => {
  const remote = remoteManifest(); delete remote.agents;
  const files = cleanFiles(); files['06 AI Team/Agents/Kaspar/AGENT.md'] = contract('Kaspar', undefined);
  const r = await run(files, { remote });
  const a = agentFindings(r);
  const note = a.filter((x) => x.severity === 'info');
  assert.equal(note.length, 1);
  assert.ok(note[0].message.includes('predates agent identities'));
  assert.ok(a.some((x) => x.severity === 'attention' && x.path === '06 AI Team/Agents/Kaspar/AGENT.md'));
  /* and with the shipped Penn renamed, the old manifest reports the canonical path missing, as it always did */
  const files2 = cleanFiles(); delete files2[PENN_PATH]; files2['06 AI Team/Agents/Nancy/AGENT.md'] = contract('Nancy', ID.penn);
  const r2 = await run(files2, { remote });
  assert.ok(r2.findings.some((x) => x.kind === 'file' && x.path === PENN_PATH && x.severity === 'attention'));
  assert.equal(agentFindings(r2).length, 1, 'only the predates line');
});

test('GREEN: a vault whose contracts all carry good ids, shipped ones at their paths, has no identity findings', async () => {
  const files = cleanFiles();
  files['06 AI Team/Agents/Kaspar/AGENT.md'] = contract('Kaspar', '8f0b7a3e-2d1c-4e5f-9a6b-1c2d3e4f5a6b');
  files['06 AI Team/Agents/Agent 01/AGENT.md'] = contract('Agent 01', NIL + ' # placeholder');
  const r = await run(files);
  assert.equal(r.health, 'ok');
  assert.deepEqual(r.findings, []);
});

test('GREEN: the myicor_id is read from the first frontmatter block only, wherever it sits in it', async () => {
  const files = cleanFiles();
  /* the private-vault shape: id first, no type:, then a body that carries its own --- rules and a stray "myicor_id:" mention */
  files[PENN_PATH] = '---\nmyicor_id: ' + ID.penn + '\nagent_version: 1.1.1\n---\n\n# Penn\n\n---\n\nmyicor_id: not-a-real-field\n';
  const r = await run(files);
  assert.equal(agentFindings(r).length, 0);
});

test('readFrontmatter: first block, key: value lines, inline comments and quotes stripped, body ignored', () => {
  const fm = engine.readFrontmatter('﻿---\r\ntype: agent\r\nmyicor_id: "' + ID.penn + '"  # minted 2026-09-07\r\nname: Penn\r\n---\r\n# Penn\r\n---\r\nrole: nope\r\n');
  assert.deepEqual(fm, { type: 'agent', myicor_id: ID.penn, name: 'Penn' });
  assert.deepEqual(engine.readFrontmatter('# no frontmatter\n---\nx: y\n---\n'), {});
  assert.deepEqual(engine.readFrontmatter('---\nunterminated: yes\n'), {});
});

test('renderReport: the agents group is counted like the others, and the AI paragraph forbids changing or reusing an id', async () => {
  const files = cleanFiles(); files['06 AI Team/Agents/Kaspar/AGENT.md'] = contract('Kaspar', undefined);
  files['.obsidian/community-plugins.json'] = '[]';
  const r = await run(files);
  const md = engine.renderReport(r, { now: new Date('2026-09-07T10:00:00Z') });
  assert.ok(md.includes('### agents (1)'));
  assert.ok(md.includes('`06 AI Team/Agents/Kaspar/AGENT.md`'));
  assert.ok(/never change or reuse a `myicor_id`/i.test(md));
  assert.ok(!md.includes('—') && !md.includes('–'), 'no em or en dashes in generated prose');
});

/* ---------------------------------------------------- config folder ---- */
/* A vault on a config-folder profile (`.obsidian-mobile`, an Obsidian Sync
   feature) keeps its plugins and appearance there. The engine takes the
   folder as an option, defaulting to `.obsidian`. Red first. */

test('RED: configDir is honoured for plugins, appearance and snippets; the default stays .obsidian', async () => {
  const files = cleanFiles();
  delete files['.obsidian/community-plugins.json']; delete files['.obsidian/plugins/icor-for-life-connect/manifest.json']; delete files['.obsidian/appearance.json'];
  files['.obsidian-mobile/community-plugins.json'] = '["icor-for-life-connect"]';
  files['.obsidian-mobile/plugins/icor-for-life-connect/manifest.json'] = '{}';
  files['.obsidian-mobile/appearance.json'] = '{"enabledCssSnippets":["gone"]}';
  const r = await run(files, { configDir: '.obsidian-mobile' });
  assert.ok(!r.findings.some((x) => x.kind === 'plugin'), 'the plugin under the profile folder must count as installed and enabled');
  const s = r.findings.find((x) => x.kind === 'snippet' && x.severity === 'attention');
  assert.ok(s && s.path === '.obsidian-mobile/snippets/gone.css');
  /* and without the option the same vault reads as a bare one: plugin not installed under .obsidian */
  const r2 = await run(files);
  assert.ok(r2.findings.some((x) => x.kind === 'plugin' && x.path === '.obsidian/plugins/icor-for-life-connect'));
});

/* ============================================== knowledge quality ===== */
/*
 * The quality numbers are measured by the scaffold's own script and only
 * READ here (GL-1005: code measures, the plugin shows). These gates hold
 * the reader and the two renderers to the schema-1 contract: the file the
 * script writes is the fixture, and every way the file can be wrong has to
 * end in one sentence rather than a throw. Red first, as ever.
 */

const QUALITY_FIXTURE = readFileSync(new URL('./fixtures/quality-1.json', import.meta.url), 'utf8');
/* The fixture says it was generated on this date; "now" is set relative to
   it so a test picks fresh or stale deliberately, never by the clock. */
const FRESH = new Date('2026-09-09T12:00:00Z');
const LATER = new Date('2026-09-30T12:00:00Z');

const qualityVault = (text) => ({
  exists: async (p) => text !== null && p === engine.QUALITY_PATH,
  read: async (p) => { if (text === null || p !== engine.QUALITY_PATH) throw new Error('ENOENT ' + p); return text; },
});

test('RED: no quality file at all is one sentence naming the script, never an error', async () => {
  const q = await engine.loadQuality(qualityVault(null), { now: FRESH });
  assert.equal(q.status, 'missing');
  assert.equal(q.health, 'unknown');
  assert.deepEqual(q.metrics, []);
  assert.ok(/check-quality\.py --write/.test(q.message), 'the sentence must name the command');
  assert.ok(/ICOR for Life Terminal/.test(q.message) && /check my notes/.test(q.message), 'and both ways to run it');
  const md = engine.renderQuality(q).join('\n');
  assert.ok(md.includes('## Knowledge quality (no data yet)'));
  assert.ok(md.includes(q.message), 'the report carries the same sentence, not a second wording');
});

test('RED: a quality file with another schema is refused, naming the schema seen and the one expected', async () => {
  const q = await engine.loadQuality(qualityVault('{"schema": 2, "health": "ok", "metrics": []}'), { now: FRESH });
  assert.equal(q.status, 'wrong-schema');
  assert.equal(q.health, 'unknown');
  assert.ok(/schema 2/.test(q.message) && /schema 1/.test(q.message), 'both numbers must be in the sentence');
  assert.deepEqual(q.metrics, []);
  /* and a file with no schema key at all is refused the same way */
  const none = engine.parseQuality('{"health": "ok"}', { now: FRESH });
  assert.equal(none.status, 'wrong-schema');
  assert.ok(/no schema/.test(none.message));
  assert.ok(engine.renderQuality(q).join('\n').includes('## Knowledge quality (unreadable)'));
});

test('RED: a quality file that is not JSON, or is JSON but not an object, is refused and never throws', async () => {
  for (const text of ['{ not json', '[]', 'null', '"a string"', '']) {
    const q = await engine.loadQuality(qualityVault(text), { now: FRESH });
    assert.equal(q.status, 'invalid', 'refused: ' + JSON.stringify(text));
    assert.equal(q.health, 'unknown');
    assert.ok(q.message.length > 0);
  }
  /* an fs that throws on read is the same one sentence, not an exception */
  const q = await engine.loadQuality({ exists: async () => true, read: async () => { throw new Error('EACCES'); } }, { now: FRESH });
  assert.equal(q.status, 'invalid');
  assert.ok(/could not be read/.test(q.message));
});

test('RED: numbers older than seven days carry a stale marker with their age; fresh ones carry none', () => {
  const stale = engine.parseQuality(QUALITY_FIXTURE, { now: LATER });
  assert.equal(stale.status, 'ok');
  assert.equal(stale.stale, true);
  assert.equal(stale.ageDays, 21);
  const md = engine.renderQuality(stale).join('\n');
  assert.ok(md.includes('**Stale:**') && md.includes('21 days old'));
  const fresh = engine.parseQuality(QUALITY_FIXTURE, { now: FRESH });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageDays, 0);
  assert.ok(!engine.renderQuality(fresh).join('\n').includes('**Stale:**'));
  /* a file whose `generated` cannot be read is stale too, and says why */
  const undated = engine.parseQuality('{"schema": 1, "health": "ok", "metrics": []}', { now: FRESH });
  assert.equal(undated.stale, true);
  assert.equal(undated.ageDays, null);
  assert.ok(engine.renderQuality(undated).join('\n').includes('no readable `generated` date'));
});

test('the quality section renders the fixture: metric table, counts, findings grouped, severity as text not colour', () => {
  const q = engine.parseQuality(QUALITY_FIXTURE, { now: FRESH });
  const md = engine.renderQuality(q).join('\n');
  assert.ok(md.startsWith('## Knowledge quality (attention)'));
  assert.ok(md.includes('Measured by `Scripts/check-quality.py` on 2026-09-09T08:30:00Z against scaffold 1.17.0'));
  assert.ok(md.includes('| Metric | Value | Severity |'));
  assert.ok(md.includes('| Notes without a link | 7 notes | (!) attention |'));
  assert.ok(md.includes('| Enum violations | 0 fields | ok |'));
  /* the scratchpad pair: one counts notes, the other counts days. Nothing
     pinned that the first time and the fixture drifted, so it is pinned now. */
  assert.ok(md.includes('| Unprocessed scratchpads | 3 notes | (!) attention |'), 'the count of scratchpads is in notes');
  assert.ok(md.includes('| Oldest unprocessed scratchpad | 4 days | (!) attention |'), 'only the oldest is in days');
  /* the script writes the unit in the plural; a value of one is singularised
     here, because how a number reads is the plugin's job and not the script's */
  assert.ok(md.includes('| Oldest unprocessed capture | 1 day | ok |'), 'one day, never "1 days"');
  assert.equal(engine.metricValueText({ value: 1, unit: 'notes' }), '1 note');
  assert.equal(engine.metricValueText({ value: 0, unit: 'notes' }), '0 notes');
  assert.equal(engine.metricValueText({ value: 1, unit: 'progress' }), '1 progress', 'a unit ending in ss is left alone');
  assert.equal(engine.metricValueText({ value: 1, unit: '' }), '1', 'no unit, no trailing space');
  assert.ok(md.includes('Counted: Journal 412, Notes 96,'), 'the counts read in the contract order');
  /* the metric table follows the contract's order, not the file's */
  const order = engine.orderedMetrics(q).map((m) => m.id);
  assert.deepEqual(order, engine.QUALITY_METRIC_IDS);
  /* findings are grouped under their metric, each one path, message, action */
  assert.ok(md.includes('### Missing required fields (2)'));
  assert.ok(md.includes('Repair procedure: SOP-1014.'));
  assert.ok(md.includes('- **`04 Inner World/My Life/Goals/run-a-marathon.md`** Required field `key_element` is missing.'));
  assert.ok(md.includes('  - Do: Anchor the goal to a Key Element'));
  /* the group heading counts the findings, and a metric with none is absent */
  assert.ok(md.includes('### Notes without a link (2)'));
  assert.ok(!md.includes('### Enum violations ('));
  assert.ok(!md.includes('—') && !md.includes('–'), 'no em or en dashes in generated prose');
});

test('a metric with more than twenty findings shows twenty and a "+n more" line', () => {
  const findings = [];
  for (let i = 0; i < 26; i++) findings.push({ metric: 'orphans', severity: 'attention', path: 'note-' + i + '.md', message: 'Nothing links to this note.', action: 'Link it.' });
  const q = engine.parseQuality(JSON.stringify({
    schema: 1, generated: '2026-09-09T08:30:00Z', health: 'attention', counts: {},
    metrics: [{ id: 'orphans', label: 'Orphans', value: 26, unit: 'notes', severity: 'attention', sop: 'SOP-1014' }],
    findings,
  }), { now: FRESH });
  const md = engine.renderQuality(q).join('\n');
  assert.equal(engine.QUALITY_FINDINGS_PER_METRIC, 20);
  assert.ok(md.includes('### Orphans (26)'));
  assert.ok(md.includes('`note-19.md`'), 'the twentieth is shown');
  assert.ok(!md.includes('`note-20.md`'), 'the twenty-first is not');
  assert.ok(md.includes('- +6 more in `' + engine.QUALITY_PATH + '`'));
});

test('a metric the script adds later is shown after the known ones; one it drops is simply absent', () => {
  const q = engine.parseQuality(JSON.stringify({
    schema: 1, generated: '2026-09-09T08:30:00Z', health: 'ok', counts: { journal: 3, bases: 9 },
    metrics: [
      { id: 'shopping_lists_unfiled', label: 'Unfiled shopping lists', value: 4, unit: 'notes', severity: 'ok' },
      { id: 'orphans', label: 'Orphans', value: 1, unit: 'notes', severity: 'ok' },
      { id: 'orphans', label: 'A duplicate id', value: 99, unit: 'notes', severity: 'broken' },
      { label: 'no id at all', value: 1 },
      { id: 'Not A Key', value: 1 },
    ],
    findings: [],
  }), { now: FRESH });
  assert.deepEqual(engine.orderedMetrics(q).map((m) => m.id), ['orphans', 'shopping_lists_unfiled']);
  assert.equal(engine.orderedMetrics(q)[0].value, 1, 'the first of a duplicated id wins, the second is dropped');
  /* an unknown count key is kept and shown after the known ones */
  assert.equal(engine.countsText(q), 'Journal 3, bases 9');
  /* a value that is not a number reads as unknown rather than NaN */
  const odd = engine.parseQuality('{"schema":1,"health":"ok","metrics":[{"id":"orphans","label":"Orphans","value":"lots"}]}', { now: FRESH });
  assert.equal(engine.metricValueText(odd.metrics[0]), 'unknown');
});

test('the report frontmatter carries quality_health, quality_generated and one key per metric id', async () => {
  const r = await run(cleanFiles());
  const q = engine.parseQuality(QUALITY_FIXTURE, { now: FRESH });
  const md = engine.renderReport(r, { now: FRESH, quality: q });
  const fm = md.slice(md.indexOf('---') + 3, md.indexOf('\n---', 3));
  assert.ok(fm.includes('quality_health: attention'));
  assert.ok(fm.includes('quality_generated: 2026-09-09T08:30:00Z'));
  assert.ok(fm.includes('quality_stale: false'));
  for (const id of engine.QUALITY_METRIC_IDS) assert.ok(new RegExp('^' + id + ': \\d+$', 'm').test(fm), 'frontmatter must carry ' + id);
  assert.ok(fm.includes('notes_missing_link: 7') && fm.includes('duplicate_entities: 0'));
  /* without data the two keys still exist and say so, and no metric key does */
  const none = engine.renderReport(r, { now: FRESH, quality: engine.parseQuality(null, { now: FRESH }) });
  const fm2 = none.slice(none.indexOf('---') + 3, none.indexOf('\n---', 3));
  assert.ok(fm2.includes('quality_health: unknown') && fm2.includes('quality_generated: unknown'));
  assert.ok(!/^orphans: /m.test(fm2));
  /* the same is true when the caller passes no quality at all */
  assert.ok(engine.renderReport(r, { now: FRESH }).includes('quality_health: unknown'));
});

test('the report puts the quality section between the severity groups and "For your AI", and the AI prompt names SOP-1014', async () => {
  const files = cleanFiles(); files['06 AI Team/Agents/Kaspar/AGENT.md'] = contract('Kaspar', undefined);
  const r = await run(files);
  const md = engine.renderReport(r, { now: FRESH, quality: engine.parseQuality(QUALITY_FIXTURE, { now: FRESH }) });
  const attention = md.indexOf('## Attention (');
  const quality = md.indexOf('## Knowledge quality (');
  const ai = md.indexOf('## For your AI');
  assert.ok(attention > 0 && quality > attention && ai > quality, 'order: the groups, then quality, then the AI prompt');
  assert.ok(/Then read the Knowledge quality section and run SOP-1014 for what it lists; propose repairs, apply only after I say yes\./.test(md));
  assert.ok(!md.includes('—') && !md.includes('–'), 'no em or en dashes in generated prose');
});

/* ----------------------------------------------------- run history ---- */
/*
 * The plugin's own file under `.icor-for-life/<plugin-id>/`. It is state,
 * not a setting, it is regenerable, and it is per device: every way it can
 * be absent or wrong has to start fresh rather than throw (GL-1008).
 */

const result = (health, broken, attention, info) => ({ health, counts: { broken, attention, info }, installedVersion: '1.17.0', latestVersion: '1.17.0', findings: [] });

test('RED: a missing, malformed or foreign-schema history starts fresh rather than throwing', async () => {
  for (const text of [null, '{ not json', '[]', '{"schema": 2, "runs": []}', '{"schema": 1}', '{"schema":1,"runs":"nope"}']) {
    const h = engine.parseHistory(text);
    assert.deepEqual(h, { schema: 1, runs: [] }, 'starts fresh: ' + JSON.stringify(text));
  }
  /* a run without an `at` timestamp is dropped, the rest survive */
  const mixed = engine.parseHistory('{"schema":1,"runs":[{"at":"2026-09-01T00:00:00Z","health":"ok"},{"health":"ok"},null,7]}');
  assert.equal(mixed.runs.length, 1);
  /* and through the fs, an absent file and a read that throws both start fresh */
  assert.deepEqual(await engine.loadHistory({ exists: async () => false, read: async () => { throw new Error('never'); } }), { schema: 1, runs: [] });
  assert.deepEqual(await engine.loadHistory({ exists: async () => true, read: async () => { throw new Error('EACCES'); } }), { schema: 1, runs: [] });
  /* appendRun over rubbish still returns a well-formed file */
  const after = engine.appendRun('not a history', engine.runRecord(result('ok', 0, 0, 0), null, new Date('2026-09-09T10:00:00Z')));
  assert.equal(after.schema, 1);
  assert.equal(after.runs.length, 1);
});

test('a run record carries both healths and one entry per metric that had a value', () => {
  const q = engine.parseQuality(QUALITY_FIXTURE, { now: FRESH });
  const rec = engine.runRecord(result('attention', 0, 3, 2), q, new Date('2026-09-09T10:00:00Z'));
  assert.equal(rec.at, '2026-09-09T10:00:00.000Z');
  assert.equal(rec.health, 'attention');
  assert.equal(rec.broken, 0); assert.equal(rec.attention, 3); assert.equal(rec.info, 2);
  assert.equal(rec.quality_health, 'attention');
  assert.equal(rec.metrics.notes_missing_link, 7);
  assert.equal(Object.keys(rec.metrics).length, engine.QUALITY_METRIC_IDS.length);
  /* a run with no quality data on disk still records, with no metrics */
  const bare = engine.runRecord(result('ok', 0, 0, 0), engine.parseQuality(null, { now: FRESH }), FRESH);
  assert.equal(bare.quality_health, 'unknown');
  assert.deepEqual(bare.metrics, {});
});

test('appending caps the history at ninety runs, keeping the newest and dropping from the front', () => {
  let h = engine.parseHistory(null);
  for (let i = 0; i < 95; i++) {
    h = engine.appendRun(h, { at: '2026-01-01T00:00:0' + (i % 10) + 'Z', health: 'ok', broken: 0, attention: 0, info: 0, quality_health: 'ok', metrics: { orphans: i } });
  }
  assert.equal(engine.HISTORY_CAP, 90);
  assert.equal(h.runs.length, 90);
  assert.equal(h.runs[0].metrics.orphans, 5, 'the first five were dropped');
  assert.equal(h.runs[89].metrics.orphans, 94, 'the newest run is last');
  /* the series the dashboard draws: oldest first, at most the limit asked for */
  const series = engine.metricSeries(h, 'orphans', 30);
  assert.equal(series.length, 30);
  assert.equal(series[0], 65);
  assert.equal(series[29], 94);
  /* a metric no run carried draws nothing, and a run missing it is skipped */
  assert.deepEqual(engine.metricSeries(h, 'never_measured', 30), []);
  assert.deepEqual(engine.metricSeries({ runs: [{ at: 'x', metrics: { orphans: 2 } }, { at: 'y' }, { at: 'z', metrics: { orphans: 'lots' } }] }, 'orphans', 30), [2]);
});

test('the sparkline path is drawn from the values alone: no values, one value, a flat series, a real one', () => {
  assert.equal(engine.sparklinePath([], 60, 16), '', 'nothing to draw is the empty string, so the caller can skip the SVG');
  assert.equal(engine.sparklinePath([4], 60, 16), 'M1.0,8.0 L59.0,8.0', 'one value draws flat at mid height');
  assert.equal(engine.sparklinePath([3, 3, 3], 60, 16), 'M1.0,8.0 L30.0,8.0 L59.0,8.0', 'a series that never changes sits at mid height');
  const d = engine.sparklinePath([0, 10], 60, 16);
  assert.equal(d, 'M1.0,15.0 L59.0,1.0', 'the low value is at the bottom, the high one at the top');
  /* every point stays inside the box, whatever the numbers are */
  const pts = engine.sparklinePath([7, 0, 130, 2, 2], 60, 16).split(' ').map((s) => s.slice(1).split(',').map(Number));
  for (const [x, y] of pts) { assert.ok(x >= 1 && x <= 59, 'x in the box: ' + x); assert.ok(y >= 1 && y <= 15, 'y in the box: ' + y); }
});

/* THE DAILY SCRATCHPAD SHAPE (GL-1004, amended 2026-09-10).
 *
 * The scaffold's own validate-scaffold.py had this rule and could not enforce
 * it: it globbed the room root, so the moment a vault nested its scratchpads
 * correctly the check matched zero files and passed by finding nothing. The
 * red cases below are the three ways a vault actually breaks the shape, and
 * the green case is the shapes real tools produce, so neither half can go
 * quiet the way that glob did. */

test('RED: a scratchpad loose at the room root is found, and the fix names the two settings that put it there', async () => {
  const files = cleanFiles();
  files['00 Daily Scratchpad/2026-09-10.md'] = 'loose\n';
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  const f = r.findings.find((x) => x.kind === 'scratchpad');
  assert.ok(f, 'the loose file is found');
  assert.equal(f.severity, 'attention');
  assert.ok(f.message.includes('YYYY/MM/'), 'the message names the nesting');
  assert.ok(f.action.includes('Daily notes') && f.action.includes('Scratchpad plugin'),
    'the fix names both settings, or the next note lands loose again');
});

test('RED: a title-named note in the capture room is found, and the fix names the wikilink that created it', async () => {
  const files = cleanFiles();
  files['00 Daily Scratchpad/2026/09/Omarchy.md'] = 'a note with a subject\n';
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  const f = r.findings.find((x) => x.kind === 'scratchpad');
  assert.ok(f && f.path === '00 Daily Scratchpad/2026/09/Omarchy.md');
  assert.ok(f.action.includes('04 Inner World/Notes/'), 'the fix names where a subject note lives');
  assert.ok(f.action.includes('wikilink'), 'the fix names the mechanism that creates these by accident');
});

test('RED: a partly nested scratchpad (year but no month) is found', async () => {
  const files = cleanFiles();
  files['00 Daily Scratchpad/2026/202609101200.md'] = 'half nested\n';
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  assert.ok(r.findings.some((x) => x.kind === 'scratchpad' && x.message.includes('YYYY/MM/')));
});

test('RED: a saved view buried in a dated folder is found; at the room root it is fine', async () => {
  const buried = cleanFiles();
  buried['00 Daily Scratchpad/2026/09/Recent Notes.base'] = 'filters:\n  and:\n    - file.ext == "md"\n';
  const r1 = await engine.runChecks({ fs: vault(buried, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  assert.ok(r1.findings.some((x) => x.kind === 'scratchpad' && x.message.includes('saved view')));

  const atRoot = cleanFiles();
  atRoot['00 Daily Scratchpad/Recent Notes.base'] = 'filters:\n  and:\n    - file.ext == "md"\n';
  const r2 = await engine.runChecks({ fs: vault(atRoot, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  assert.equal(r2.findings.filter((x) => x.kind === 'scratchpad').length, 0, 'a view at the root is where it belongs');
});

test('GREEN: every shape the real tools produce passes, so the check cannot be satisfied by an empty room', async () => {
  const files = cleanFiles();
  files['00 Daily Scratchpad/2026/09/2026-09-10.md'] = 'daily note\n';
  files['00 Daily Scratchpad/2026/09/202609101200.md'] = 'quick capture\n';
  files['00 Daily Scratchpad/2026/09/202609101201 - Claude Reset times.md'] = 'titled after the fact\n';
  files['00 Daily Scratchpad/2026/09/202609101201 2.md'] = 'same minute, second note\n';
  files['00 Daily Scratchpad/2026/09/Untitled.md'] = 'subject note, not yet named\n';
  files['00 Daily Scratchpad/2026/09/2026-09-10_canvas.canvas'] = '{}\n';
  files['00 Daily Scratchpad/2026/09/2026-09-06_canvas-test-2 - 1.canvas'] = '{}\n';
  files['00 Daily Scratchpad/2026/08/202608091440.md'] = 'last month\n';
  files['00 Daily Scratchpad/Recent Notes.base'] = 'filters:\n  and:\n    - file.ext == "md"\n';
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  const found = r.findings.filter((x) => x.kind === 'scratchpad');
  assert.equal(found.length, 0, 'nothing invented on a correct room: ' + JSON.stringify(found.map((f) => f.path)));
});

test('the shape matcher is judged on its own, one case per rule', () => {
  const ok = (p) => assert.equal(engine.scratchpadProblem(p), null, p + ' should pass');
  const bad = (p, why) => assert.equal(engine.scratchpadProblem(p), why, p + ' should fail as ' + why);
  ok('00 Daily Scratchpad/2026/09/2026-09-10.md');
  ok('00 Daily Scratchpad/2026/09/202609101200.md');
  ok('00 Daily Scratchpad/2026/09/202609101200 - A Title.md');
  ok('00 Daily Scratchpad/2026/09/202609101200 2.md');
  ok('00 Daily Scratchpad/2026/09/2026-09-10-143216.md');
  ok('00 Daily Scratchpad/2026/09/2026-09-10_canvas.canvas');
  ok('00 Daily Scratchpad/README.md');
  ok('00 Daily Scratchpad/2026/09/README.md');
  bad('00 Daily Scratchpad/2026-09-10.md', 'nesting');
  bad('00 Daily Scratchpad/2026/2026-09-10.md', 'nesting');
  bad('00 Daily Scratchpad/2026/09/10/2026-09-10.md', 'nesting');
  bad('00 Daily Scratchpad/2026/09/Omarchy.md', 'name');
  bad('00 Daily Scratchpad/2026/09/Vo UU.md', 'name');
  bad('00 Daily Scratchpad/2026/09/view.base', 'nesting-base');
});


/* THE GENERATED HARNESS LAYER (scaffold 1.23.0).
 *
 * `scaffold-init.py apply` writes the skills, the Codex and Gemini shims,
 * the hook configs and the host pointers from THIS vault's own frontmatter.
 * So two vaults on one scaffold version hold different bytes in these files
 * on purpose, and the three-way file check called every one of them "you
 * edited this file" on any vault that had hired a single agent. That was the
 * defect these gates were written against, and the first two cases are the
 * two halves of it: a correctly regenerated file must not be blamed, and a
 * hand-edited one must be, because the next apply overwrites it silently.
 *
 * The header fixtures below are real generator output, not this plugin's
 * idea of it: the GEMINI.md line is copied byte for byte out of scaffold
 * 1.23.0, and the JSON one was hashed by the generator's own arithmetic in
 * Python. A test that builds its input with the same code it is testing
 * proves only that the code agrees with itself.
 */

const GEMINI_REAL = '<!-- GENERATED by scaffold-init.py from `AGENTS.md`. content-hash:3098e19039e6. Do not hand-edit: change the source and re-run the generator. -->\n@AGENTS.md\n\nGemini CLI reads this file. `AGENTS.md` next to it is the contract; there is no second copy of it here.\n';
const HOOKS_REAL = '{\n  "description": "GENERATED by scaffold-init.py from `06 AI Team/AI Team Knowledge/Scripts/hooks-rules.json`. content-hash:73de15a4480f. Do not hand-edit: change the table and re-run the generator.",\n  "hooks": {\n    "PreToolUse": [\n      {\n        "matcher": "Edit|Write",\n        "hooks": [\n          {\n            "type": "command",\n            "command": "python3 guard.py"\n          }\n        ]\n      }\n    ]\n  }\n}\n';
const SKILL_PATH = '06 AI Team/AI Team Knowledge/Skills/checkpoint/SKILL.md';
const SKILL_REAL = '---\nname: checkpoint\ndescription: "Ends a session on purpose."\n---\n<!-- GENERATED by scaffold-init.py from `06 AI Team/AI Team Knowledge/Workstreams/WS-1005-checkpoint.md`. content-hash:PLACEHOLDER. Do not hand-edit: change the source and re-run the generator. -->\n\nYou are Larry.\n';

/* The manifest's copy of a generated file is whatever the SCAFFOLD's own
   vault produced, which is never what a member's vault produces. Every
   harness fixture below therefore differs from the manifest hash on
   purpose: that is the situation, not a corruption of it. */
function harnessManifest(paths) {
  const m = remoteManifest();
  for (const [path, kind] of paths) m.files.push({ path, sha256: sha('what the scaffold vault produced'), kind, example: false });
  return m;
}

test('the hash arithmetic is the generator\'s: real 1.23.0 output verifies intact, both shapes', async () => {
  const md = await engine.generatedState('GEMINI.md', GEMINI_REAL, hash);
  assert.equal(md.state, 'intact', 'the markdown header, byte for byte from scaffold 1.23.0');
  assert.equal(md.source, 'AGENTS.md');
  const js = await engine.generatedState('.codex/hooks.json', HOOKS_REAL, hash);
  assert.equal(js.state, 'intact', 'the JSON header lives in a value and hashes the hooks key alone');
  assert.equal(js.source, '06 AI Team/AI Team Knowledge/Scripts/hooks-rules.json');
});

test('GREEN: a generated file the member never touched is reported as generated, never as edited', async () => {
  const files = cleanFiles();
  files['GEMINI.md'] = GEMINI_REAL;
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: harnessManifest([['GEMINI.md', 'doc']]), local: null, installedVersion: '1.5.0' });
  const f = r.findings.find((x) => x.path === 'GEMINI.md');
  assert.ok(f, 'the difference from the manifest is still noticed');
  assert.equal(f.kind, 'generated');
  assert.equal(f.severity, 'info');
  assert.ok(f.message.includes('still matches the hash'), f.message);
  assert.ok(!/you edited|You edited/.test(f.message), 'a regenerated file is not an edit the member made');
});

test('RED: a generated file edited by hand is found, and the fix is the generator and never the edit', async () => {
  const files = cleanFiles();
  files['GEMINI.md'] = GEMINI_REAL + '\nAlways answer in German.\n';
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: harnessManifest([['GEMINI.md', 'doc']]), local: null, installedVersion: '1.5.0' });
  const f = r.findings.find((x) => x.path === 'GEMINI.md');
  assert.equal(f.kind, 'generated');
  assert.equal(f.severity, 'attention');
  assert.ok(f.message.includes('edited by hand'), f.message);
  assert.ok(f.action.includes('scaffold-init.py') && f.action.includes('apply'), 'the fix names the script');
  assert.ok(f.action.includes('AGENTS.md'), 'and names the source to put the change in');
  assert.ok(f.action.includes('overwrites'), 'and says what happens if it is left alone');
});

test('RED: a missing generated file is fixed by the generator, never by copying from the scaffold', async () => {
  const r = await engine.runChecks({ fs: vault(cleanFiles(), cleanFolders), hash, remote: harnessManifest([[SKILL_PATH, 'doc'], ['.codex/agents/penn.toml', 'doc']]), local: null, installedVersion: '1.5.0' });
  for (const path of [SKILL_PATH, '.codex/agents/penn.toml']) {
    const f = r.findings.find((x) => x.path === path);
    assert.equal(f.kind, 'generated', path);
    assert.ok(f.action.includes('scaffold-init.py'), path + ': the fix names the script');
    assert.ok(!f.action.includes('Copy it in'), path + ': a generated file is never copied in');
  }
});

test('RED: the generator\'s own source is not a generated file, though it carries the marker', async () => {
  /* scaffold-init.py holds GEN_MARK as a string constant and run-red-tests.py
     quotes it. Matching on the marker alone reported both as generated files
     that had lost their hash: a finding on the very script that would fix it,
     which a member can neither act on nor silence. The header is the marker
     AND a content-hash on the same line. */
  const SOURCE = '#!/usr/bin/env python3\nGEN_MARK = "GENERATED by scaffold-init.py"\n\ndef md_header(source, body):\n    return "<!-- %s from `%s`. content-hash:%s. -->" % (GEN_MARK, source, _hash(body))\n';
  assert.equal(await engine.generatedState('06 AI Team/AI Team Knowledge/Scripts/scaffold-init.py', SOURCE, hash), null);
  const files = cleanFiles();
  files['06 AI Team/AI Team Knowledge/Scripts/scaffold-init.py'] = SOURCE;
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: harnessManifest([['06 AI Team/AI Team Knowledge/Scripts/scaffold-init.py', 'script']]), local: null, installedVersion: '1.5.0' });
  const f = r.findings.find((x) => x.path.endsWith('scaffold-init.py'));
  assert.equal(f.kind, 'file', 'it is an ordinary file the three-way check judges');
});

test('the Claude Code shims stay hand-kept: the generator leaves them alone and so does this check', async () => {
  /* `scaffold-init.py plan` classifies every .claude/agents/<slug>.md as KEEP,
     because they carry body lines the contract does not. Treating them as
     generated would tell a member to run a generator that will not touch
     them, and the real fix, copying the shipped shim back in, would never be
     offered. */
  assert.equal(engine.isHarnessPath('.claude/agents/penn.md'), false);
  assert.equal(engine.isHarnessPath('.codex/agents/penn.toml'), true);
  assert.equal(engine.isHarnessPath('.gemini/agents/penn.md'), true);
  assert.equal(engine.isHarnessPath('06 AI Team/AI Team Knowledge/Skills/checkpoint/SKILL.md'), true);
  assert.equal(engine.isHarnessPath('06 AI Team/AI Team Knowledge/Skills/README.md'), false, 'the room README is not a skill');
  const files = cleanFiles();
  files[PENN_SHIM] = PENN_SHIM_TEXT + 'Always answer in German.\n';
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: remoteManifest(), installedVersion: '1.5.0' });
  const f = r.findings.find((x) => x.path === PENN_SHIM);
  assert.equal(f.kind, 'file', 'an ordinary file, judged against the copy the member installed');
  assert.ok(f.message.includes('You edited this file'), f.message);
});

test('.claude/settings.json is owned in part, so a difference is expected and never a copy-it-back', async () => {
  const files = cleanFiles();
  files['.claude/settings.json'] = '{\n  "hooks": {},\n  "model": "opus"\n}\n';
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: harnessManifest([['.claude/settings.json', 'config']]), local: null, installedVersion: '1.5.0' });
  const f = r.findings.find((x) => x.path === '.claude/settings.json');
  assert.equal(f.kind, 'generated');
  assert.equal(f.severity, 'info');
  assert.ok(f.action.includes('Never copy this file in'), f.action);
});

/* THE HOST LINK LAYER, `.agents/skills/`.
 *
 * Written by the generator, never tracked and never shipped, so it is per
 * device. Absent means this device has not run the generator, which is a
 * choice; a link with nothing behind it means Codex, Gemini CLI and Cursor
 * read nothing and say nothing about it, which is damage. The two must not
 * be confused, and the third case, an adapter that cannot look, must claim
 * neither. */

test('GREEN: no .agents/skills folder at all is not a finding', async () => {
  const files = cleanFiles();
  files[SKILL_PATH] = SKILL_REAL;
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  assert.equal(r.findings.filter((f) => f.kind === 'harness-link').length, 0);
});

test('GREEN: every skill linked and resolving is not a finding', async () => {
  const files = cleanFiles();
  files[SKILL_PATH] = SKILL_REAL;
  const links = { present: true, resolved: ['checkpoint'], listed: ['checkpoint'] };
  const r = await engine.runChecks({ fs: vault(files, cleanFolders, links), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  assert.equal(r.findings.filter((f) => f.kind === 'harness-link').length, 0);
});

test('RED: a link left behind for a skill this vault no longer has is found, and the fix is the generator', async () => {
  const files = cleanFiles();
  files[SKILL_PATH] = SKILL_REAL;
  const links = { present: true, resolved: ['checkpoint'], listed: ['checkpoint', 'red-tests'] };
  const r = await engine.runChecks({ fs: vault(files, cleanFolders, links), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  const f = r.findings.find((x) => x.kind === 'harness-link');
  assert.ok(f && f.path === '.agents/skills/red-tests', JSON.stringify(f));
  assert.equal(f.severity, 'attention');
  assert.ok(f.message.includes('report no error'), 'the point of the finding is that the host is silent about it');
  assert.ok(f.action.includes('scaffold-init.py') && f.action.includes('apply'));
});

test('RED: a skill the links cannot reach is found once the folder exists', async () => {
  const files = cleanFiles();
  files[SKILL_PATH] = SKILL_REAL;
  files['06 AI Team/AI Team Knowledge/Skills/red-tests/SKILL.md'] = SKILL_REAL;
  const links = { present: true, resolved: ['checkpoint'], listed: ['checkpoint'] };
  const r = await engine.runChecks({ fs: vault(files, cleanFolders, links), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  const f = r.findings.find((x) => x.kind === 'harness-link');
  assert.ok(f && f.path === '.agents/skills/red-tests', JSON.stringify(f));
  assert.ok(f.message.includes('only Claude Code'), f.message);
});

/* THE CASE THE CHECK EXISTS FOR (Flint, 2026-09-14, condition 1).
 *
 * On desktop `FileSystemAdapter.list` stats every entry it lists, `stat`
 * follows a symlink, and a link whose target is gone throws ENOENT, so the
 * whole listing rejects. The dangling link never appears in the output: it
 * destroys the output. Reading that as "the adapter cannot look here" turned
 * the one input this check was written to catch into an Info line saying
 * nothing is wrong, which is a guard whose green is reachable without the
 * thing being true. */

test('RED: a listing that rejected is the finding, not a reason to go quiet', async () => {
  const files = cleanFiles();
  files[SKILL_PATH] = SKILL_REAL;
  const links = { present: true, listable: false, resolved: ['checkpoint'] };
  const r = await engine.runChecks({ fs: vault(files, cleanFolders, links), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  const folder = r.findings.find((x) => x.kind === 'harness-link' && x.path === '.agents/skills');
  assert.ok(folder, 'the folder itself is reported');
  assert.equal(folder.severity, 'attention', 'never an Info line: this is the case the check is for');
  assert.ok(folder.message.includes('points at nothing'), folder.message);
  assert.ok(folder.action.includes('scaffold-init.py') && folder.action.includes('apply'));
  assert.equal(r.findings.filter((x) => x.kind === 'harness-link' && x.severity === 'info').length, 0);
});

test('a listing that rejected does not stop the per-skill probe: every known skill is still judged', async () => {
  const files = cleanFiles();
  files[SKILL_PATH] = SKILL_REAL;
  files['06 AI Team/AI Team Knowledge/Skills/red-tests/SKILL.md'] = SKILL_REAL;
  const links = { present: true, listable: false, resolved: ['checkpoint'] };
  const r = await engine.runChecks({ fs: vault(files, cleanFolders, links), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  const rows = r.findings.filter((x) => x.kind === 'harness-link');
  assert.ok(rows.some((x) => x.path === '.agents/skills/red-tests'), 'the skill behind the broken listing is still named: ' + JSON.stringify(rows.map((x) => x.path)));
  assert.ok(!rows.some((x) => x.path === '.agents/skills/checkpoint'), 'and one that does resolve is not, since exists follows the link and never throws');
});

test('a phone is told the truth about why: the hosts do not run there, not that the adapter cannot look', async () => {
  const files = cleanFiles();
  files[SKILL_PATH] = SKILL_REAL;
  files['06 AI Team/AI Team Knowledge/Skills/red-tests/SKILL.md'] = SKILL_REAL;
  const r = await engine.runChecks({ fs: vault(files, cleanFolders, { mobile: true }), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  const rows = r.findings.filter((f) => f.kind === 'harness-link');
  assert.equal(rows.length, 1, 'one line, never one per skill: a phone cannot act on any of them');
  assert.equal(rows[0].severity, 'info');
  assert.ok(rows[0].message.includes('Not checked on this device'), rows[0].message);
  assert.ok(rows[0].message.includes('do not run here'), 'it says why, and the reason is the platform rather than the adapter');
  assert.ok(!/adapter/i.test(rows[0].message), 'the adapter is not the reason and must not be blamed');
});

test('an engine handed an fs from an older plugin build does not throw over the missing method', async () => {
  const fs = vault(cleanFiles(), cleanFolders);
  delete fs.hostSkillLinks;
  delete fs.listSkillNames;
  const r = await engine.runChecks({ fs, hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  assert.equal(r.findings.filter((f) => f.kind === 'harness-link').length, 1, 'it degrades to not-checked');
});

/* THE MACHINE LAYER IS STATE, NEVER DRIFT (GL-1008).
 *
 * checkpoint.py writes one receipt per session and a session.json, and the
 * generator writes harness.json. Nothing regenerates them from a source in
 * the vault, nothing ships them, and no manifest should carry them. If one
 * ever does, that is an upstream defect, and pointing a member at it would
 * be this plugin repeating the defect in every vault. */

test('receipts, session.json and the other machine files are never reported, even from a manifest', async () => {
  const files = cleanFiles();
  files['.icor-for-life/scripts/receipts/2026-09-14T10-00.json'] = '{"schema":1}';
  files['.icor-for-life/scripts/session.json'] = '{"schema":1}';
  files['.icor-for-life/scripts/harness.json'] = '{"schema":1}';
  const remote = harnessManifest([['.icor-for-life/scripts/session.json', 'config']]);
  remote.history[0].removed.push({ path: '.icor-for-life/scripts/receipts/2026-09-14T10-00.json', note: 'never shipped' });
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote, local: null, installedVersion: '1.4.2' });
  /* `.icor-for-life/VERSION` is the one file under here that is NOT state:
     it ships with the scaffold and says which version this vault came from,
     so the version finding below is correct and stays. */
  const leaked = r.findings.filter((f) => f.path.startsWith('.icor-for-life/scripts/') || f.path.startsWith('.icor-for-life/icor-for-life-'));
  assert.deepEqual(leaked.map((f) => f.path), [], 'nothing the machine layer regenerates is drift');
  assert.ok(r.findings.some((f) => f.path === '.icor-for-life/VERSION'), 'and the version file, which does ship, is still read');
});

/* THE HARNESS BLOCK, `.icor-for-life/scripts/harness.json` (schema 1).
 *
 * The generator looks at the hosts; this plugin reads the one file and shows
 * it. Absent is the normal state of a vault whose owner has not asked, so it
 * is one sentence with the command in it and never an error. */

const HARNESS_JSON = JSON.stringify({
  schema: 1,
  generated: '2026-09-14T19:28:35Z',
  scaffold_version: '1.23.0',
  skills: { count: 3, tokens: 341, budget: 4000 },
  files: { generated: 29, hand_kept: 8, orphans: 0 },
  tests: { status: 'ok', summary: 'OK 214 passed', skips: ['SKIP pyyaml not installed'] },
  problems: [],
  notes: [],
  hosts: [
    { id: 'claude-code', detected: ['.claude/ present', '`claude` on PATH'], installed: '3 skills, 8 shims', trusted: 'unknown', trusted_note: 'stored outside the vault', tested: 'ok', unsupported: [] },
    { id: 'gemini', detected: ['.gemini/ present'], installed: '8 shims', trusted: 'unknown', trusted_note: '', tested: 'unsupported', unsupported: ['hooks'] },
  ],
});

test('the harness file is read, and every host reaches the report and its frontmatter', () => {
  const h = engine.parseHarness(HARNESS_JSON);
  assert.equal(h.status, 'ok');
  assert.equal(h.health, 'ok');
  assert.equal(h.hosts.length, 2);
  assert.equal(h.hosts[0].label, 'Claude Code');
  assert.equal(h.hosts[1].label, 'Gemini CLI');
  assert.deepEqual(h.hosts[1].unsupported, ['hooks']);
  assert.equal(h.skills.tokens, 341);
  assert.equal(h.files.handKept, 8);
  const text = engine.renderHarness(h).join('\n');
  assert.ok(text.includes('## Harness (ok)'));
  assert.ok(text.includes('Claude Code') && text.includes('Gemini CLI'));
  assert.ok(/\| unknown \|/.test(text), 'trusted: unknown reaches the table as a word a person reads');
  assert.ok(text.includes('not applicable'), 'a host with no hook system is not reported as an untested one');
  assert.ok(text.includes('SKIP pyyaml not installed'), 'a skip is shown, because a skip is not a pass');
  const fm = engine.harnessFrontmatter(h).join('\n');
  assert.ok(fm.includes('harness_health: ok') && fm.includes('harness_hosts_detected: 2') && fm.includes('harness_tests: ok'));
});

test('a red suite or a generator problem lifts the harness to attention', () => {
  const red = JSON.parse(HARNESS_JSON); red.tests.status = 'red'; red.tests.summary = 'RED, exit 1';
  assert.equal(engine.parseHarness(JSON.stringify(red)).health, 'attention');
  const prob = JSON.parse(HARNESS_JSON); prob.problems = ['SOP-1016 has triggers and no skill_name'];
  const h = engine.parseHarness(JSON.stringify(prob));
  assert.equal(h.health, 'attention');
  assert.ok(engine.renderHarness(h).join('\n').includes('SOP-1016'));
});

test('no harness file is one sentence carrying the command, never an error', () => {
  const h = engine.parseHarness(null);
  assert.equal(h.status, 'missing');
  assert.equal(h.health, 'unknown');
  assert.deepEqual(h.hosts, []);
  const text = engine.renderHarness(h).join('\n');
  assert.ok(text.includes('doctor --json'), 'it says what to run');
  assert.ok(text.includes('scaffold-init.py'));
  assert.ok(!/error|failed/i.test(text), 'not having run something is not a failure');
});

test('a harness file this plugin cannot read is refused in one sentence and never thrown', () => {
  const bad = engine.parseHarness('{ not json');
  assert.equal(bad.status, 'invalid');
  assert.ok(bad.message.includes('doctor --json'));
  const wrong = engine.parseHarness(JSON.stringify({ schema: 7, hosts: [] }));
  assert.equal(wrong.status, 'wrong-schema');
  assert.ok(wrong.message.includes('schema 7') && wrong.message.includes('schema 1'));
  const unknownHost = engine.parseHarness(JSON.stringify({ schema: 1, hosts: [{ id: 'zed' }, { id: 'codex' }] }));
  assert.deepEqual(unknownHost.hosts.map((h) => h.id), ['codex'], 'a host this plugin has no label for is dropped, never guessed');
});

test('the harness reaches the report note through renderReport', async () => {
  const r = await engine.runChecks({ fs: vault(cleanFiles(), cleanFolders), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  const withData = engine.renderReport(r, { harness: engine.parseHarness(HARNESS_JSON) });
  assert.ok(withData.includes('## Harness (ok)'));
  assert.ok(withData.includes('harness_health: ok'));
  const without = engine.renderReport(r, {});
  assert.ok(without.includes('## Harness (no data yet)'));
  assert.ok(without.includes('harness_health: unknown'));
  assert.ok(without.includes('never hand-edit anything under Generated harness layer'), 'the AI paragraph carries the generator rule');
});

test('loadHarness reads the file at the path GL-1008 gives it, and absent never throws', async () => {
  /* 0.7.0: the harness is team state, `.mypka/state/harness.json` first; the
     pre-split location is still read, second, and labelled as old. */
  const files = cleanFiles();
  files['.icor-for-life/scripts/harness.json'] = HARNESS_JSON;
  assert.equal(engine.HARNESS_PATH, '.mypka/state/harness.json');
  assert.equal(engine.HARNESS_PATH_OLD, '.icor-for-life/scripts/harness.json');
  const there = await engine.loadHarness(vault(files, cleanFolders));
  assert.equal(there.status, 'ok');
  assert.equal(there.oldLocation, true);
  assert.ok(engine.renderHarness(there).join('\n').includes('**Old location:**'));
  files['.mypka/state/harness.json'] = HARNESS_JSON.replace('"scaffold_version":"1.23.0"', '"scaffold_version":null,"mypka_version":"1.0.0"');
  const both = await engine.loadHarness(vault(files, cleanFolders));
  assert.equal(both.path, '.mypka/state/harness.json', 'the new location wins when both exist');
  assert.equal(both.oldLocation, false);
  assert.equal(both.mypkaVersion, '1.0.0');
  assert.ok(engine.renderHarness(both).join('\n').includes('against myPKA 1.0.0'));
  const gone = await engine.loadHarness(vault(cleanFiles(), cleanFolders));
  assert.equal(gone.status, 'missing');
});

test('the report heads the new groups with words, not with the kind\'s machine name', async () => {
  const files = cleanFiles();
  files['GEMINI.md'] = GEMINI_REAL + '\nAlways answer in German.\n';
  files['00 Daily Scratchpad/2026-09-10.md'] = 'loose\n';
  files['06 AI Team/AI Team Knowledge/Skills/red-tests/SKILL.md'] = SKILL_REAL;
  const links = { present: true, resolved: [], listed: ['red-tests'] };
  const r = await engine.runChecks({ fs: vault(files, cleanFolders, links), hash, remote: harnessManifest([['GEMINI.md', 'doc']]), local: null, installedVersion: '1.5.0' });
  const text = engine.renderReport(r, {});
  assert.ok(text.includes('### Generated harness layer'), 'a member reads "generated harness layer", never "generated"');
  assert.ok(text.includes('### Host skill links'));
  assert.ok(text.includes('### Daily Scratchpad'));
});

test('a suite that never ran is not given a green\'s caveat, and does not stutter its own status', () => {
  const skipped = JSON.parse(HARNESS_JSON);
  skipped.tests = { status: 'skipped', summary: 'not run (--no-tests)', skips: [] };
  const text = engine.renderHarness(engine.parseHarness(JSON.stringify(skipped))).join('\n');
  assert.ok(text.includes('Red tests: not run (--no-tests)'), text);
  assert.ok(!text.includes('not run. not run'), 'the status and the summary are not both printed when they say the same thing');
  assert.ok(!text.includes('What a green here does not prove'), 'a caveat about a green belongs only under a green');
  const green = engine.renderHarness(engine.parseHarness(HARNESS_JSON)).join('\n');
  assert.ok(green.includes('What a green here does not prove'));
});

/* CRLF (Flint, 2026-09-14, condition 2).
 *
 * The generator hashes LF text on every platform and cannot avoid it: Python
 * writes with the default newline, which becomes os.linesep, and reads back
 * under universal newlines, so on Windows the file is CRLF on disk and LF in
 * the hash. Hashing the raw bytes here would call every generated file
 * hand-edited on Windows forever, and the fix it printed (run apply) rewrites
 * the same bytes, so the finding could never clear. */

test('RED: a generated file with Windows line endings is intact, not hand-edited', async () => {
  const crlf = GEMINI_REAL.replace(/\n/g, '\r\n');
  const r = await engine.generatedState('GEMINI.md', crlf, hash);
  assert.equal(r.state, 'intact', 'the same file, saved on Windows, is the same file');
  const lone = GEMINI_REAL.replace(/\n/g, '\r');
  assert.equal((await engine.generatedState('GEMINI.md', lone, hash)).state, 'intact', 'a lone CR too, which is what Python read_text does');
  const edited = crlf + 'Always answer in German.\r\n';
  assert.equal((await engine.generatedState('GEMINI.md', edited, hash)).state, 'edited', 'and a real edit is still caught through CRLF');
});

/* Twenty-two lines that each say "nothing to do" bury the one that says
   something is wrong, and the result modal truncates at forty rows. */

test('intact generated files are counted, not listed, and the ones needing a hand still get their own line', async () => {
  const files = cleanFiles();
  const paths = [];
  for (const n of ['charta', 'iris', 'mack', 'nolan']) {
    const path = '.gemini/agents/' + n + '.md';
    files[path] = GEMINI_REAL;
    paths.push([path, 'doc']);
  }
  files['GEMINI.md'] = GEMINI_REAL + '\nAlways answer in German.\n';
  paths.push(['GEMINI.md', 'doc']);
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: harnessManifest(paths), local: null, installedVersion: '1.5.0' });
  const text = engine.renderReport(r, {});
  assert.ok(text.includes('**4 generated files, all current.**'), 'the four that are fine are one line: ' + text.slice(text.indexOf('## Info')));
  for (const n of ['charta', 'iris', 'mack', 'nolan']) assert.ok(!text.includes('.gemini/agents/' + n + '.md'), n + ' is counted, not listed');
  assert.ok(text.includes('`GEMINI.md`') && text.includes('edited by hand'), 'the one that needs a hand keeps its own line and its fix');
});

test('a single intact generated file keeps its own line, because a summary of one is longer than the one', async () => {
  const files = cleanFiles();
  files['GEMINI.md'] = GEMINI_REAL;
  const r = await engine.runChecks({ fs: vault(files, cleanFolders), hash, remote: harnessManifest([['GEMINI.md', 'doc']]), local: null, installedVersion: '1.5.0' });
  const text = engine.renderReport(r, {});
  assert.ok(text.includes('`GEMINI.md`'), text.slice(text.indexOf('## Info')));
  assert.ok(!text.includes('generated files, all current'));
});

/* CODEX TRUST AND THE SANDBOX (Mack's pilot, 2026-09-14).
 *
 * `codex exec` never asks about hooks and silently runs none it has not been
 * told to trust, so a member with untrusted hooks has every guard off and a
 * terminal that looks exactly like one where they are on. The generator reads
 * Codex's own config and says which; this plugin puts the answer where it will
 * be seen, with the sentence that says what to do under the table rather than
 * in a cell that scrolls sideways. */

const TRUST_JSON = (over) => JSON.stringify({
  schema: 1, generated: '2026-09-14T21:00:00Z', scaffold_version: '1.23.0',
  skills: { count: 3, tokens: 341, budget: 4000 },
  files: { generated: 26, hand_kept: 8, orphans: 0 },
  tests: { status: 'ok', summary: 'OK 313/313', skips: [] },
  problems: [], notes: [],
  hosts: [
    { id: 'claude-code', detected: ['.claude/ present'], installed: '3 skills', trusted: 'unknown', trusted_note: 'stored outside the vault', tested: 'ok', unsupported: [] },
    Object.assign({
      id: 'codex', detected: ['.codex/ present'], installed: '8 shims (TOML)',
      trusted: 'no',
      trusted_note: 'NOT TRUSTED, guards off in codex exec until trusted. ~/.codex/config.toml carries no [hooks.state] entry for "/v/.codex/hooks.json". Open Codex in this folder once and trust them.',
      tested: 'ok', unsupported: [],
      sandbox: true,
      sandbox_note: "Codex's workspace-write sandbox refuses writes into .codex/ and .agents/, so scaffold-init.py apply must be run by the member from their own terminal.",
    }, over || {}),
  ],
});

test('an untrusted Codex reaches the report as a word in the table and a sentence under it', () => {
  const h = engine.parseHarness(TRUST_JSON());
  assert.equal(h.status, 'ok');
  const codex = h.hosts.find((x) => x.id === 'codex');
  assert.equal(codex.trusted, 'no');
  assert.equal(codex.sandbox, true);
  assert.ok(codex.sandboxNote.includes('workspace-write'));
  const text = engine.renderHarness(h).join('\n');
  assert.ok(/\| NOT TRUSTED \|/.test(text), 'the table says it in a word: ' + text);
  assert.ok(text.includes('**Codex, trust:**'), 'and the reason is a line of its own');
  assert.ok(text.includes('Open Codex in this folder once and trust them.'), 'carrying the fix verbatim from the generator');
  assert.ok(text.includes('**Codex, sandbox:**') && text.includes('from their own terminal'), 'and the sandbox note is shown because this host has one');
  /* Asserted on the parsed value, not only on the rendered text: Claude Code
     carries no sandbox_note either, so a `sandbox` that parsed as always true
     would still render no line here and the text assertion alone would stay
     green over it. Watched, and that is why both are here. */
  const cc = h.hosts.find((x) => x.id === 'claude-code');
  assert.equal(cc.sandbox, false, 'a host whose row has no sandbox key does not get one invented');
  assert.equal(cc.sandboxNote, '');
  assert.ok(!text.includes('**Claude Code, sandbox:**'), 'a host with no sandbox gets no sandbox line');
  assert.ok(engine.harnessFrontmatter(h).join('\n').includes('harness_untrusted_hosts: codex'));
});

test('a trusted Codex drops the trust line and keeps the sandbox one', () => {
  const h = engine.parseHarness(TRUST_JSON({ trusted: 'yes', trusted_note: 'yes, for this exact path.' }));
  const text = engine.renderHarness(h).join('\n');
  assert.ok(/\| yes \|/.test(text));
  assert.ok(!text.includes('**Codex, trust:**'), 'nothing to act on, so nothing under the table');
  assert.ok(text.includes('**Codex, sandbox:**'), 'the sandbox is still there whether or not the hooks are trusted');
  assert.ok(!engine.harnessFrontmatter(h).join('\n').includes('harness_untrusted_hosts'));
});

test('an unreadable Codex config says unknown and never no', () => {
  const h = engine.parseHarness(TRUST_JSON({ trusted: 'unknown', trusted_note: 'not readable: ~/.codex/config.toml could not be read, so this says nothing rather than guessing.' }));
  const text = engine.renderHarness(h).join('\n');
  assert.ok(/\| unknown \|/.test(text));
  assert.ok(!text.includes('NOT TRUSTED'), 'a file that could not be opened is never reported as a vault that is not trusted');
  assert.ok(text.includes('says nothing rather than guessing'), 'and the reason is shown, because unknown without a reason is just silence');
});

test('a host that is not trusted lifts the harness health, and an unknown one does not', () => {
  assert.equal(engine.parseHarness(TRUST_JSON()).health, 'attention', 'not trusted is something to act on');
  assert.equal(engine.parseHarness(TRUST_JSON({ trusted: 'yes', trusted_note: 'yes, for this exact path.' })).health, 'ok');
  assert.equal(engine.parseHarness(TRUST_JSON({ trusted: 'unknown', trusted_note: 'not readable.' })).health, 'ok',
    'a file that could not be read is not a finding, and must not paint the tile');
  const text = engine.renderHarness(engine.parseHarness(TRUST_JSON())).join('\n');
  assert.ok(text.includes('## Harness (attention)'), 'the heading never says ok over a line saying guards are off');
});
