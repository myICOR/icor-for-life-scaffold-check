/* THE SECRETS GATES.
 *
 * Where the GitHub token lives (0.3.0): the env-file parser and writer, the
 * backend choice, the data.json migration, and the store wrapper. All pure;
 * the file system and Obsidian's keychain are fakes here. Same rule as the
 * engine gates: every guard is watched going red before it is trusted, so
 * the red cases come first. No test in this file ever prints a value.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { secrets } = require('../main.js');
const { SECRET_ID, ENV_KEY, DEFAULT_ENV_FILE, BACKEND_STORE, BACKEND_ENV, readEnvValue, writeEnvValue, resolveBackend, secretStorageUsable, SecretStore, migrateToken } = secrets;

/* A fake of app.secretStorage: the three synchronous methods, an id rule,
   and a switch that makes setSecret throw, for the refusal cases. */
function fakeStorage({ refuse = false } = {}) {
  const map = new Map();
  return {
    map,
    setSecret(id, v) { if (refuse) throw new Error('refused'); if (!/^[a-z0-9-]+$/.test(id)) throw new Error('bad id'); map.set(id, v); },
    getSecret(id) { return map.has(id) ? map.get(id) : null; },
    listSecrets() { return [...map.keys()]; },
  };
}

/* The shape of Tom's real file: comments, blank lines, bare values, and NO
   terminator on the last line. The values here are fixtures, not secrets. */
const ENV_NO_FINAL_NEWLINE = '# Credentials\n\n# ── Supabase ──\nSUPABASE_ACCESS_TOKEN=aaaa\n\nCLICKUP_API_KEY=bbbb';
const ENV_WITH_TOKEN = '# head\nGITHUB_TOKEN=ghp_old\nOTHER=1\n';

/* Every line except the one that may change, for byte-identity checks. */
const others = (text, key) => text.split(/(?<=\n)/).filter((l) => !new RegExp('^\\s*' + key + '\\s*=').test(l));

/* ---------------------------------------------------------- the constants */

test('the id and the key are the ones the suite contract names', () => {
  assert.equal(SECRET_ID, 'icor-for-life-scaffold-check-github-token');
  assert.match(SECRET_ID, /^[a-z0-9-]+$/, 'the store accepts lowercase, digits and dashes only');
  assert.ok(SECRET_ID.length <= 64);
  assert.equal(ENV_KEY, 'GITHUB_TOKEN');
  assert.equal(DEFAULT_ENV_FILE, '06 AI Team/AI Team Knowledge/.env');
});

/* -------------------------------------------------------------- the reader */

test('RED: a key that is only in a comment line is not a value', () => {
  assert.equal(readEnvValue('# GITHUB_TOKEN=ghp_commented\n', ENV_KEY), '');
  assert.equal(readEnvValue('  # GITHUB_TOKEN=ghp_commented\n', ENV_KEY), '');
});

test('RED: a key that is a prefix or a suffix of the wanted one is not it', () => {
  assert.equal(readEnvValue('GITHUB_TOKEN_OLD=x\nMY_GITHUB_TOKEN=y\n', ENV_KEY), '');
});

test('RED: an absent key, an empty file and a non-string read as unset', () => {
  assert.equal(readEnvValue('A=1\nB=2\n', ENV_KEY), '');
  assert.equal(readEnvValue('', ENV_KEY), '');
  assert.equal(readEnvValue(null, ENV_KEY), '');
  assert.equal(readEnvValue(undefined, ENV_KEY), '');
});

test('RED: a key name outside the KEY shape is refused, so a caller cannot inject a line', () => {
  assert.throws(() => readEnvValue('A=1\n', 'A=1\nB'), /env key/);
  assert.throws(() => writeEnvValue('', 'BAD KEY', 'x'), /env key/);
});

test('the value is found, trimmed, with blanks around the = and indentation tolerated', () => {
  assert.equal(readEnvValue('GITHUB_TOKEN=ghp_a\n', ENV_KEY), 'ghp_a');
  assert.equal(readEnvValue('  GITHUB_TOKEN = ghp_b  \n', ENV_KEY), 'ghp_b');
  assert.equal(readEnvValue(ENV_WITH_TOKEN, ENV_KEY), 'ghp_old');
});

test('a value runs to the end of its line: quotes and a # are part of it, nothing is interpolated', () => {
  assert.equal(readEnvValue('GITHUB_TOKEN="ghp_q"\n', ENV_KEY), '"ghp_q"');
  assert.equal(readEnvValue('GITHUB_TOKEN=ghp_x # note\n', ENV_KEY), 'ghp_x # note');
  assert.equal(readEnvValue('GITHUB_TOKEN=${OTHER}\n', ENV_KEY), '${OTHER}');
});

test('the last line wins when a key appears twice, and a file without a final newline reads to its last byte', () => {
  assert.equal(readEnvValue('GITHUB_TOKEN=first\nGITHUB_TOKEN=second\n', ENV_KEY), 'second');
  assert.equal(readEnvValue(ENV_NO_FINAL_NEWLINE, 'CLICKUP_API_KEY'), 'bbbb');
});

test('CRLF files read the same as LF files', () => {
  assert.equal(readEnvValue('A=1\r\nGITHUB_TOKEN=ghp_crlf\r\nB=2\r\n', ENV_KEY), 'ghp_crlf');
});

/* -------------------------------------------------------------- the writer */

test('RED: a value with a line break is refused, since it would become a second line', () => {
  assert.throws(() => writeEnvValue('A=1\n', ENV_KEY, 'ghp\nEVIL=1'), /line break/);
  assert.throws(() => writeEnvValue('A=1\n', ENV_KEY, 'ghp\r\nEVIL=1'), /line break/);
});

test('RED: a comment line naming the key is left alone and a real line is appended', () => {
  const before = '# GITHUB_TOKEN=ghp_commented\nA=1\n';
  const after = writeEnvValue(before, ENV_KEY, 'ghp_new');
  assert.equal(after, '# GITHUB_TOKEN=ghp_commented\nA=1\nGITHUB_TOKEN=ghp_new\n');
});

test('appending to a file whose last line has no terminator first ends that line: the real file shape', () => {
  const after = writeEnvValue(ENV_NO_FINAL_NEWLINE, ENV_KEY, 'ghp_new');
  assert.equal(after, ENV_NO_FINAL_NEWLINE + '\nGITHUB_TOKEN=ghp_new\n');
  assert.ok(after.startsWith(ENV_NO_FINAL_NEWLINE), 'every byte that was there is still there, in place');
  assert.equal(readEnvValue(after, 'CLICKUP_API_KEY'), 'bbbb', 'the line that had no terminator is still a whole line');
});

test('appending to a file that ends with a newline adds exactly one line; an empty file becomes that one line', () => {
  assert.equal(writeEnvValue('A=1\n', ENV_KEY, 'ghp_new'), 'A=1\nGITHUB_TOKEN=ghp_new\n');
  assert.equal(writeEnvValue('', ENV_KEY, 'ghp_new'), 'GITHUB_TOKEN=ghp_new\n');
  assert.equal(writeEnvValue(null, ENV_KEY, 'ghp_new'), 'GITHUB_TOKEN=ghp_new\n');
});

test('updating in place rewrites only that line; every other line is byte-identical', () => {
  const before = '# head\n\n  GITHUB_TOKEN = ghp_old\nOTHER=1\n# tail';
  const after = writeEnvValue(before, ENV_KEY, 'ghp_new');
  assert.deepEqual(others(after, ENV_KEY), others(before, ENV_KEY));
  assert.equal(after, '# head\n\n  GITHUB_TOKEN =ghp_new\nOTHER=1\n# tail', 'indentation and the blanks before = are kept; the value follows the =');
  assert.equal(readEnvValue(after, ENV_KEY), 'ghp_new');
});

test('the last of two lines is the one rewritten, which is also the one the reader returns', () => {
  const after = writeEnvValue('GITHUB_TOKEN=first\nGITHUB_TOKEN=second\n', ENV_KEY, 'third');
  assert.equal(after, 'GITHUB_TOKEN=first\nGITHUB_TOKEN=third\n');
  assert.equal(readEnvValue(after, ENV_KEY), 'third');
});

test('CRLF is kept on a rewritten line and used for an appended one', () => {
  assert.equal(writeEnvValue('A=1\r\nGITHUB_TOKEN=old\r\nB=2\r\n', ENV_KEY, 'new'), 'A=1\r\nGITHUB_TOKEN=new\r\nB=2\r\n');
  assert.equal(writeEnvValue('A=1\r\nB=2\r\n', ENV_KEY, 'new'), 'A=1\r\nB=2\r\nGITHUB_TOKEN=new\r\n');
  assert.equal(writeEnvValue('A=1\r\nB=2', ENV_KEY, 'new'), 'A=1\r\nB=2\r\nGITHUB_TOKEN=new\r\n');
});

test('idempotent: writing the same value twice is the same file, for append and for update', () => {
  for (const before of [ENV_NO_FINAL_NEWLINE, ENV_WITH_TOKEN, '', 'A=1\n']) {
    const once = writeEnvValue(before, ENV_KEY, 'ghp_same');
    assert.equal(writeEnvValue(once, ENV_KEY, 'ghp_same'), once);
  }
});

test('clearing blanks the line to KEY= and keeps it; clearing a key the file does not have changes nothing', () => {
  assert.equal(writeEnvValue(ENV_WITH_TOKEN, ENV_KEY, ''), '# head\nGITHUB_TOKEN=\nOTHER=1\n');
  assert.equal(readEnvValue(writeEnvValue(ENV_WITH_TOKEN, ENV_KEY, ''), ENV_KEY), '');
  assert.equal(writeEnvValue('A=1\n', ENV_KEY, ''), 'A=1\n');
  assert.equal(writeEnvValue(ENV_NO_FINAL_NEWLINE, ENV_KEY, ''), ENV_NO_FINAL_NEWLINE);
  assert.equal(writeEnvValue('', ENV_KEY, ''), '');
});

test('round trip: what is written is what is read, whitespace trimmed', () => {
  for (const v of ['ghp_abc123', '  ghp_padded  ', 'github_pat_11AAAA_bbbb']) {
    assert.equal(readEnvValue(writeEnvValue(ENV_NO_FINAL_NEWLINE, ENV_KEY, v), ENV_KEY), v.trim());
  }
});

/* --------------------------------------------------------- the backend */

test('the keychain is the default when this Obsidian has one, the env file otherwise; a saved env-file choice always holds', () => {
  assert.equal(resolveBackend('', true), BACKEND_STORE);
  assert.equal(resolveBackend(undefined, true), BACKEND_STORE);
  assert.equal(resolveBackend('', false), BACKEND_ENV);
  assert.equal(resolveBackend(BACKEND_ENV, true), BACKEND_ENV);
  assert.equal(resolveBackend(BACKEND_ENV, false), BACKEND_ENV);
  assert.equal(resolveBackend(BACKEND_STORE, true), BACKEND_STORE);
  assert.equal(resolveBackend(BACKEND_STORE, false), BACKEND_ENV, 'a saved keychain choice on a device without one reads the env file');
  assert.equal(resolveBackend('nonsense', true), BACKEND_STORE);
});

/* ----------------------------------------------------------- the store */

test('RED: the store is detected by its two methods, never assumed', () => {
  assert.equal(secretStorageUsable(undefined), false);
  assert.equal(secretStorageUsable(null), false);
  assert.equal(secretStorageUsable({}), false);
  assert.equal(secretStorageUsable({ getSecret() {} }), false);
  assert.equal(secretStorageUsable(fakeStorage()), true);
  const none = new SecretStore(undefined);
  assert.equal(none.available(), false);
  assert.equal(none.get(SECRET_ID), '');
  assert.equal(none.set(SECRET_ID, 'x'), false, 'no store: the caller must keep the value where it was');
});

test('RED: a store that refuses the value says so, and nothing is recorded', () => {
  const st = new SecretStore(fakeStorage({ refuse: true }));
  assert.equal(st.available(), true);
  assert.equal(st.set(SECRET_ID, 'ghp_x'), false);
  assert.equal(st.get(SECRET_ID), '');
});

test('get is never null; set trims; set of an empty value clears; clear of an absent id is fine', () => {
  const st = new SecretStore(fakeStorage());
  assert.equal(st.get(SECRET_ID), '');
  assert.equal(st.set(SECRET_ID, '  ghp_x  '), true);
  assert.equal(st.get(SECRET_ID), 'ghp_x');
  assert.equal(st.set(SECRET_ID, ''), true);
  assert.equal(st.get(SECRET_ID), '');
  assert.equal(st.clear(SECRET_ID), true);
});

/* ------------------------------------------------------- the migration */

const DATA_JSON_0_2_0 = JSON.parse(readFileSync(new URL('./fixtures/data-json-0.2.0.json', import.meta.url), 'utf8'));

test('RED: in env-file mode a token in data.json is NOT moved on its own, not into the store and not into the file', () => {
  const s = structuredClone(DATA_JSON_0_2_0);
  const st = new SecretStore(fakeStorage());
  assert.equal(migrateToken(s, st, BACKEND_ENV), false);
  assert.equal(s.githubToken, DATA_JSON_0_2_0.githubToken, 'the field is left as it was');
  assert.equal(st.get(SECRET_ID), '');
});

test('RED: a store that refuses the token leaves data.json as it was, so the token always has a home', () => {
  const s = structuredClone(DATA_JSON_0_2_0);
  assert.equal(migrateToken(s, new SecretStore(fakeStorage({ refuse: true })), BACKEND_STORE), false);
  assert.equal(s.githubToken, DATA_JSON_0_2_0.githubToken);
  assert.equal(migrateToken(s, new SecretStore(undefined), BACKEND_STORE), false);
  assert.equal(s.githubToken, DATA_JSON_0_2_0.githubToken);
});

test('a 0.2.0 data.json in keychain mode: the token moves into the store under the suite id, the field is blanked, and every other field is untouched', () => {
  const s = structuredClone(DATA_JSON_0_2_0);
  const storage = fakeStorage();
  const st = new SecretStore(storage);
  assert.equal(migrateToken(s, st, BACKEND_STORE), true, 'data.json must be saved');
  assert.equal(s.githubToken, '');
  assert.equal(storage.map.get(SECRET_ID), DATA_JSON_0_2_0.githubToken.trim());
  assert.deepEqual(storage.listSecrets(), [SECRET_ID], 'one id, the suite-prefixed one');
  const { githubToken: _a, ...restBefore } = DATA_JSON_0_2_0;
  const { githubToken: _b, ...restAfter } = s;
  assert.deepEqual(restAfter, restBefore);
  assert.equal(JSON.stringify(s).includes(DATA_JSON_0_2_0.githubToken), false, 'what will be written to disk no longer carries the token');
});

test('idempotent: a second load moves nothing and asks for no save; a blank or missing field asks for no save', () => {
  const s = structuredClone(DATA_JSON_0_2_0);
  const st = new SecretStore(fakeStorage());
  assert.equal(migrateToken(s, st, BACKEND_STORE), true);
  assert.equal(migrateToken(s, st, BACKEND_STORE), false);
  assert.equal(migrateToken({ githubToken: '' }, st, BACKEND_STORE), false);
  assert.equal(migrateToken({ githubToken: '   ' }, st, BACKEND_STORE), false);
  assert.equal(migrateToken({}, st, BACKEND_STORE), false);
  assert.equal(migrateToken(null, st, BACKEND_STORE), false);
});

/* ---------------------------------------------------- the quiet source */

test('the plugin source never prints: no console call, no alert, no token in a string literal', () => {
  const src = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.equal(/\bconsole\s*\./.test(src), false, 'a console call is one place a value could leak');
  assert.equal(/\balert\s*\(/.test(src), false);
  assert.equal(/\bthis\.settings\.githubToken\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), true, 'the field is still read for the migration and the move button');
  assert.equal(/Authorization[^\n]*githubToken/.test(src), false, 'the request header is built from readToken(), never from data.json');
});
