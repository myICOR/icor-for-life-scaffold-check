/* A hostile manifest (Vex, 0.7.0 review). A manifest is fetched from a URL
 * the member typed, so every path and every note in it is untrusted input:
 * a path that climbs out of the vault is never read, a note never carries
 * live markdown into the report, and a manifest too large to be one is
 * refused before it is parsed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const Module = require('node:module');
const STUB = join(here, 'stubs', 'obsidian.cjs');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'obsidian' ? STUB : resolveFilename.call(this, request, ...rest);
};
const { stub } = require(STUB);
const ScaffoldCheckPlugin = require('../main.js');
const { engine } = ScaffoldCheckPlugin;

const HOSTILE = ['../../etc/passwd', 'a/../../b.md', '/etc/passwd', 'C:/Windows/x.md', 'a\\b.md', 'a/./b.md', 'a//b.md', 'x'.repeat(600)];

test('RED: a `..` path (and every other unsafe path) in a hostile manifest is skipped', () => {
  const list = engine.normalizeManifest({ schema: 1, files: [{ path: 'ok/a.md', sha256: 'x' }, ...HOSTILE.map((p) => ({ path: p, sha256: 'x' }))] });
  assert.deepEqual([...list.files.keys()], ['ok/a.md']);
  const map = engine.normalizeManifest({ schema: 2, files: Object.fromEntries([['ok/a.md', 'x'], ...HOSTILE.map((p) => [p, 'x'])]) });
  assert.deepEqual([...map.files.keys()], ['ok/a.md']);

  const m = engine.normalizeManifest({ schema: 2, files: {}, history: [{ version: '9.0.0',
    removed: [{ path: '../../secret.md' }, { path: 'gone.md', moved_to: '../out.md' }, { path: 'fine.md' }],
    renamed: [{ from: '../x.md', to: 'y.md' }, { from: 'x.md', to: '../../y.md' }, { from: 'old.md', to: 'new.md' }] }] });
  assert.deepEqual(engine.removalsSince(m, '1.0.0').map((r) => r.path), ['fine.md', 'old.md']);
});

test('RED: a markdown image in a history note is stripped before it reaches the report', () => {
  const m = engine.normalizeManifest({ schema: 2, files: {}, history: [{ version: '9.0.0',
    removed: [{ path: 'a.md', note: 'see ![x](https://evil.test/p.png) <img src=x>' }],
    renamed: [{ from: 'b.md', to: 'c ![y](q.png) <b>.md' }] }] });
  const [removed, renamed] = engine.removalsSince(m, '1.0.0');
  for (const s of [removed.note, renamed.note.replace(/^renamed to `|`$/g, '')]) {
    assert.doesNotMatch(s, /[!\[\]<>()`]/, s);
  }
  assert.ok(removed.note.length <= 200);
});

test('RED: an oversized manifest is refused before it is parsed', async () => {
  let parsed = false;
  stub.onRequest = () => ({ status: 200, text: '{"files":{}, "pad":"' + 'x'.repeat(5e6) + '"}', get json() { parsed = true; return { files: {} }; } });
  try {
    const p = Object.create(ScaffoldCheckPlugin.prototype);
    p.readToken = async () => null;
    await assert.rejects(p.fetchRemote('https://manifests.example.test/manifest.json'), /manifest too large/);
  } finally { stub.onRequest = null; }
  assert.equal(parsed, false);
});
