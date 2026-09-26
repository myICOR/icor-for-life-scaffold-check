/* THE MANIFEST URL MIGRATION (0.7.1).
 *
 * The scaffold repo moved from TomSolid to myICOR. 0.7.0 and earlier saved
 * the old default URL into data.json, where it outranks DEFAULTS on every
 * load, so members kept reading the old address. The real onload() runs here
 * through the Obsidian stub, with only the host calls it makes faked on the
 * subject, so the gate covers the save as well as the rewrite.
 *
 *   1. the old default is migrated to DEFAULT_MANIFEST_URL and saved once;
 *   2. a custom URL is left alone and nothing is saved;
 *   3. an empty field stays empty in data.json, and the check reads the
 *      default in its place.
 *
 * Each was watched going red before it was trusted (see the commit).
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
const ScaffoldCheckPlugin = require('../main.js');
const { DEFAULT_MANIFEST_URL, LEGACY_MANIFEST_URL, migrateManifestUrl, effectiveManifestUrl } = ScaffoldCheckPlugin.manifestSettings;

const OLD = 'https://raw.githubusercontent.com/TomSolid/icor-for-life-scaffold/main/.icor-for-life/manifest.json';
const CUSTOM = 'https://manifests.example.test/.icor-for-life/manifest.json';

/* A plugin whose data.json is `saved`. Every host call onload() makes is a
   no-op; saveData records what would reach disk. */
function pluginLoading(saved) {
  const p = Object.create(ScaffoldCheckPlugin.prototype);
  const writes = [];
  const el = { addClass() {}, empty() {}, createSpan() { return { setAttribute() {} }; }, setAttribute() {} };
  p.app = { workspace: { onLayoutReady() {} }, vault: { configDir: '.obsidian' } };
  p.loadData = async () => structuredClone(saved);
  p.saveData = async (d) => { writes.push(structuredClone(d)); };
  p.addStatusBarItem = () => el;
  p.registerDomEvent = () => {};
  p.registerView = () => {};
  p.addRibbonIcon = () => {};
  p.addCommand = () => {};
  p.addSettingTab = () => {};
  return { p, writes };
}

test('the legacy constant is exactly the 0.7.0 default, and not the new one', () => {
  assert.equal(LEGACY_MANIFEST_URL, OLD);
  assert.notEqual(DEFAULT_MANIFEST_URL, OLD);
  assert.match(DEFAULT_MANIFEST_URL, /^https:\/\/raw\.githubusercontent\.com\/myICOR\/icor-for-life-scaffold\//);
});

test('RED 1: a saved old default is migrated to the new default and saved once', async () => {
  const { p, writes } = pluginLoading({ manifestUrl: OLD, runOnStartup: false, reportFolder: 'x' });
  await p.onload();
  assert.equal(p.settings.manifestUrl, DEFAULT_MANIFEST_URL);
  assert.equal(writes.length, 1, 'saved exactly once');
  assert.equal(writes[0].manifestUrl, DEFAULT_MANIFEST_URL);
  assert.equal(writes[0].reportFolder, 'x', 'every other field is untouched');
  assert.equal(migrateManifestUrl(p.settings), false, 'idempotent: a second pass moves nothing');
});

test('RED 2: a custom URL is left alone and nothing is saved', async () => {
  for (const url of [CUSTOM, OLD + ' ', OLD.replace('/main/', '/dev/')]) {
    const { p, writes } = pluginLoading({ manifestUrl: url, runOnStartup: false });
    await p.onload();
    assert.equal(p.settings.manifestUrl, url, url);
    assert.equal(writes.length, 0, url);
  }
});

test('RED 3: an empty field stays empty on disk, and the check reads the default', async () => {
  const { p, writes } = pluginLoading({ manifestUrl: '', runOnStartup: false });
  await p.onload();
  assert.equal(p.settings.manifestUrl, '');
  assert.equal(writes.length, 0);
  assert.equal(effectiveManifestUrl(p.settings), DEFAULT_MANIFEST_URL);
  assert.equal(effectiveManifestUrl({ manifestUrl: '   ' }), DEFAULT_MANIFEST_URL);
  assert.equal(effectiveManifestUrl({}), DEFAULT_MANIFEST_URL);
  assert.equal(effectiveManifestUrl({ manifestUrl: CUSTOM }), CUSTOM);

  /* The run itself: the URL handed to the network is the default. The fake
     fetch stops the run at its first step. */
  const seen = [];
  p.fetchRemote = async (url) => { seen.push(url); throw new Error('stop here'); };
  p.paintStatus = () => {};
  p.run({ interactive: false }).catch(() => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(seen[0], DEFAULT_MANIFEST_URL);
});
