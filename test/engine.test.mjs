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

const require = createRequire(import.meta.url);
const { engine } = require('../main.js');

const sha = (s) => createHash('sha256').update(s).digest('hex');
const hash = async (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');

/* An in-memory vault: files is path -> string; folders are inferred from
   file paths plus an explicit list, so an empty required folder can exist. */
function vault(files, folders = []) {
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
  };
}

const GL006 = '---\ntype: guideline\n---\n# GL-006\n';
const README = '# ICOR for Life Scaffold\n';

function remoteManifest(extra = {}) {
  return Object.assign({
    schema: 1, version: '1.5.0', rooms: ['04 Inner World/Journal', '06 AI Team/Agents'],
    plugins: ['icor-for-life-connect'], snippets: [],
    files: [
      { path: 'README.md', sha256: sha(README), kind: 'doc', example: false },
      { path: '06 AI Team/AI Team Knowledge/Guidelines/GL-006-bases-and-live-views.md', sha256: sha(GL006), kind: 'guideline', example: false },
      { path: '04 Inner World/Contacts/People/Alex Rivera.md', sha256: sha('example'), kind: 'doc', example: true },
    ],
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
  '.icor-for-life/VERSION': '1.5.0\n',
  '.obsidian/community-plugins.json': '["icor-for-life-connect"]',
  '.obsidian/plugins/icor-for-life-connect/manifest.json': '{}',
  '.obsidian/appearance.json': '{"enabledCssSnippets":[]}',
});
const cleanFolders = ['04 Inner World/Journal', '06 AI Team/Agents'];

/* ------------------------------------------------------------- RED ---- */

test('RED: a missing required folder is broken', async () => {
  const r = await engine.runChecks({ fs: vault(cleanFiles(), ['04 Inner World/Journal']), hash, remote: remoteManifest(), local: null, installedVersion: '1.5.0' });
  assert.equal(r.health, 'broken');
  assert.ok(r.findings.some((f) => f.kind === 'room' && f.path === '06 AI Team/Agents'));
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
  const r = await engine.runChecks({ fs: vault(files, ['04 Inner World/Journal']), hash, remote: remoteManifest(), local: null, installedVersion: '1.4.2' });
  const md = engine.renderReport(r, { now: new Date('2026-09-01T10:00:00Z'), manifestUrl: 'https://example.test/m.json' });
  assert.ok(md.startsWith('---\ntype: scaffold-check\ndate: 2026-09-01\nhealth: broken\n'));
  assert.ok(md.includes('installed_version: 1.4.2'));
  assert.ok(md.includes('## Broken (1)'));
  assert.ok(md.includes('`06 AI Team/Agents`'));
  assert.ok(md.includes('`.obsidian/snippets/icor-rooms.css`'));
  assert.ok(md.includes('## For your AI'));
  assert.ok(!md.includes('—'), 'no em dashes in generated prose');
});
