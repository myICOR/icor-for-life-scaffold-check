/* The plugin side of the split (0.7.0): what only the plugin class does, run
 * through the Obsidian stub. Two things: the GitHub token reaches GitHub
 * and nothing else, now that there are two manifest URLs; and the run
 * history is never the thing that plants `.icor-for-life/` in a folder that
 * is not ICOR for Life.
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

function pluginWith(files) {
  const folders = new Set();
  for (const p of Object.keys(files)) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/')); }
  const p = Object.create(ScaffoldCheckPlugin.prototype);
  p.app = { vault: { configDir: '.obsidian', adapter: {
    exists: async (x) => x in files || folders.has(x),
    read: async (x) => files[x],
    mkdir: async (x) => { folders.add(x); },
    write: async (x, t) => { files[x] = t; },
  } } };
  p.settings = {};
  p.readToken = async () => 'ghp_test_only_not_a_token';
  return p;
}

test('RED: the token is sent to a GitHub host and never to another one', async () => {
  const seen = [];
  stub.onRequest = (req) => { seen.push({ url: req.url, auth: req.headers.Authorization || null }); return { status: 200, json: { schema: 1, files: {} } }; };
  try {
    const p = pluginWith({});
    await p.fetchRemote('https://raw.githubusercontent.com/myICOR/mypka/main/.mypka/manifest.json');
    await p.fetchRemote('https://manifests.example.test/.mypka/manifest.json');
    await p.fetchRemote('http://localhost:8000/icor-for-life/.icor-for-life/manifest.json');
  } finally { stub.onRequest = null; }
  assert.equal(seen[0].auth, 'Bearer ghp_test_only_not_a_token');
  assert.equal(seen[1].auth, null);
  assert.equal(seen[2].auth, null);
});

test('RED: no run history is written, and no `.icor-for-life/` created, in a folder without one', async () => {
  const files = { 'AGENTS.md': '# team\n' };
  const p = pluginWith(files);
  await p.appendHistory({ health: 'ok', counts: { broken: 0, attention: 0, info: 0 } }, null);
  assert.deepEqual(Object.keys(files), ['AGENTS.md']);
  assert.equal(await p.app.vault.adapter.exists('.icor-for-life'), false);

  const withMeta = { '.icor-for-life/VERSION': '2.0.0\n' };
  const q = pluginWith(withMeta);
  await q.appendHistory({ health: 'ok', counts: { broken: 0, attention: 0, info: 0 } }, null);
  assert.ok(engine.HISTORY_PATH in withMeta, 'with the folder there, the history is written as before');
});
