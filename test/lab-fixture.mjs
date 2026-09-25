/* The split lab, pinned in this repo (test/fixtures/lab-6.0.0/). Built by
 * test/fixtures/build-lab-fixture.mjs from the lab commits named in
 * provenance.json; the gate never reads a live folder.
 *
 *   labFile(tree, path)      the bytes of one file, as a Buffer
 *   labJson(tree, path)      one file parsed as JSON, a fresh copy per call
 *   materialize(dst, ...t)   writes the trees into dst in order, a later
 *                            tree over an earlier one (an update unpacked
 *                            over a vault), and returns dst
 *
 * Trees: 'icor-for-life' (2.0.0), 'mypka' (6.0.0), 'scaffold-1.34.1'
 * (the pre-split Scaffold, f7dd5f0).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lab-6.0.0');
const bundle = JSON.parse(gunzipSync(readFileSync(join(DIR, 'trees.json.gz'))).toString('utf8'));

export const provenance = JSON.parse(readFileSync(join(DIR, 'provenance.json'), 'utf8'));

function tree(name) {
  const t = bundle.trees[name];
  if (!t) throw new Error('no fixture tree ' + name);
  return t;
}
const bytes = (e) => ('t' in e ? Buffer.from(e.t, 'utf8') : Buffer.from(e.b, 'base64'));

export function labFile(name, path) {
  const e = tree(name)[path];
  if (!e) throw new Error('no ' + path + ' in fixture tree ' + name);
  return bytes(e);
}

export const labJson = (name, path) => JSON.parse(labFile(name, path).toString('utf8'));

export function materialize(dst, ...names) {
  mkdirSync(dst, { recursive: true });
  for (const name of names) {
    for (const [p, e] of Object.entries(tree(name))) {
      const abs = join(dst, p);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes(e));
    }
  }
  return dst;
}
