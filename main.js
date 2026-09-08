/*
 * ICOR for Life - Scaffold Check: is this vault up to date with the ICOR for
 * Life Scaffold, and is what it has still intact?
 *
 * What it does:
 *   1. Reads the vault's own version folder, `.icor-for-life/` (VERSION and
 *      manifest.json), which says which scaffold version this vault was
 *      copied from.
 *   2. Fetches the manifest of the LATEST scaffold version from a URL set in
 *      the settings.
 *   3. Compares the two against the files actually on disk and reports:
 *        - the version gap;
 *        - every canonical file that is MISSING, CHANGED BY YOU, or CHANGED
 *          UPSTREAM since you installed (three answers, three actions);
 *        - LEFTOVERS: files the scaffold removed or moved after your version
 *          that are still here, each with the changelog line that explains it;
 *        - structure: the rooms, the plugins the vault expects, every Base
 *          pointing at a folder that exists, every enabled snippet present;
 *        - AGENT IDENTITY: every agent contract carries a stable `myicor_id`
 *          (scaffold 1.11.0); shipped agents are found by that id, so a
 *          renamed agent is intact, not missing, and a contract without an
 *          id, with a malformed or placeholder one, or sharing one with
 *          another contract, is named.
 *   4. Writes the report as a note the user can act on, or hand to their AI.
 *
 * What it never does: it never changes a scaffold file. The only things it
 * writes are the report note, its own data.json, and, when the GitHub token
 * is kept in an env file, that file's one GITHUB_TOKEN line. Files the
 * scaffold never shipped are yours and are not counted; extra is not drift.
 *
 * The token (0.3.0) lives in Obsidian's keychain (`app.secretStorage`) or,
 * by choice or on an Obsidian without one, in a KEY=value env file in the
 * vault; never in data.json any more. See "where the token lives" below.
 *
 * The check engine is pure (no Obsidian, no network) and exported on
 * module.exports.engine so `node --test` can run it against an in-memory
 * vault. `require('obsidian')` is guarded for that reason.
 */

'use strict';

let obsidian = null;
try { obsidian = require('obsidian'); } catch (e) { obsidian = null; }

const META_DIR = '.icor-for-life';
const DEFAULT_MANIFEST_URL =
  'https://raw.githubusercontent.com/TomSolid/icor-for-life-scaffold/main/.icor-for-life/manifest.json';
const DEFAULT_REPORT_FOLDER = '06 AI Team/AI Team Knowledge/Scaffold Check';
const STATUS_TEXT = { ok: 'Scaffold ok', attention: 'Scaffold: attention', broken: 'Scaffold: broken', offline: 'Scaffold: offline', unknown: 'Scaffold: not checked' };

/* ======================================================= the engine ===== */

/* "1.4.2" -> [1,4,2]; anything unparseable -> null. */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/* -1, 0, 1 ; null when either side is not a version. */
function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/* The folders a .base filters on. Same regex the scaffold's own check-bases
   uses, so the two agree about what a Base "points at". */
function baseFolders(text) {
  const out = new Set();
  const re = /file\.inFolder\("([^"]+)"\)/g;
  let m;
  while ((m = re.exec(String(text)))) out.add(m[1]);
  return [...out];
}

/* Every path in the manifest history that was removed AFTER `installed`.
   With no installed version, every removal in history counts, because a
   vault that does not know its own version could be any age. */
function removalsSince(manifest, installed) {
  const out = [];
  for (const h of manifest.history || []) {
    const after = installed ? compareVersions(h.version, installed) > 0 : true;
    if (!after) continue;
    for (const r of h.removed || []) out.push({ path: r.path, sha256: r.sha256 || '', note: r.note || '', version: h.version });
    for (const r of h.renamed || []) out.push({ path: r.from, sha256: r.from_sha256 || '', note: 'renamed to `' + r.to + '`', version: h.version, to: r.to });
  }
  return out;
}

/* ---------------------------------------------- agent identities ----- */

const AGENTS_DIR = '06 AI Team/Agents';
const NIL_ID = '00000000-0000-0000-0000-000000000000';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MINT_FIX = 'Run the hiring SOP step (`uuidgen | tr A-Z a-z`, written as `myicor_id`) or `mint-agent-ids.py --map` with the scaffold\'s export. Never invent an id by hand and never copy another agent\'s.';

/* The first `---` block of a note as { key: value }: top-level `key: value`
   lines only, quotes and a trailing ` # comment` stripped, later keys win
   as in YAML. Nothing nested, nothing multi-line: the identity fields are
   flat scalars and this reader is all the plugin needs. A BOM, CRLF, and a
   `---` in the body are all tolerated. No frontmatter, or an unterminated
   block, is {}. */
function readFrontmatter(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== '---') return {};
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---' || line === '...') return out;
    const m = /^([A-Za-z0-9_][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    let v = (m[2] || '').replace(/\s+#.*$/, '').trim();
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return {};
}

/* Templates carry the nil id on purpose: the placeholder plus a name that
   starts with "Agent " (the shipped `Agent 01`) or "_" (a member's own). */
function isTemplateName(name) {
  return /^(Agent |_)/.test(String(name || ''));
}

/* Every `06 AI Team/Agents/<Name>/AGENT.md` as { path, folder, name, id },
   where id is the raw frontmatter value (undefined when absent) and name
   is the frontmatter `name` or, failing that, the folder. */
async function readContracts(fs) {
  const out = [];
  for (const path of await fs.listAgentContracts()) {
    let fm = {};
    try { fm = readFrontmatter(await fs.read(path)); } catch (e) { fm = {}; }
    const folder = path.split('/').slice(-2, -1)[0] || '';
    out.push({ path, folder, name: fm.name || folder, id: fm.myicor_id });
  }
  return out;
}

/*
 * checkAgents({ fs, remote, add })
 *
 * Rule 1, identity-aware matching of the manifest's shipped agents, and
 * rule 2, the local health of every contract. Returns the set of canonical
 * paths the file check must NOT report as missing, because the agent was
 * found by id somewhere else (its contract, and its shim if one exists at
 * another slug). A manifest without `agents` (older than 1.11.0) runs
 * rule 2 only and says so once.
 */
async function checkAgents({ fs, remote, add }) {
  const skipMissing = new Set();
  const contracts = await readContracts(fs);
  const claimed = new Set(); /* paths rule 1 already reported; rule 2 stays quiet on them */

  const shipped = Array.isArray(remote.agents) ? remote.agents : null;
  if (!shipped) {
    add('agents', 'info', META_DIR + '/manifest.json',
      'The latest manifest predates agent identities (no `agents` key), so shipped agents are matched by path only.',
      'Nothing to do. A newer scaffold manifest names one id per shipped agent, and this check will then find a renamed agent by its id.');
  } else {
    for (const a of shipped) {
      if (!a || typeof a !== 'object' || !a.myicor_id || !a.path) continue;
      const hits = contracts.filter((c) => c.id === a.myicor_id);
      const found = hits.find((c) => c.path === a.path) || hits[0];
      if (found) {
        if (found.path === a.path) continue; /* case a: the file rules apply, unchanged */
        /* case b: same identity, the member's own name and folder */
        add('agents', 'info', found.path,
          'Shipped agent ' + a.name + ' lives at `' + found.path + '` under your name `' + found.folder + '`; identity intact.',
          'Nothing to do. The scaffold tracks the id, not the folder name; updates to ' + a.name + ' apply to this file.');
        skipMissing.add(a.path);
        if (a.shim && !(await fs.exists(a.shim))) {
          for (const sp of await fs.listShims()) {
            let txt = '';
            try { txt = await fs.read(sp); } catch (e) { txt = ''; }
            if (txt.includes(found.path) || txt.includes(AGENTS_DIR + '/' + found.folder + '/')) { skipMissing.add(a.shim); break; }
          }
        }
        continue;
      }
      /* case c: nothing carries the id, but something sits at the canonical path */
      const atPath = contracts.find((c) => c.path === a.path);
      if (atPath) {
        claimed.add(atPath.path);
        if (!atPath.id) {
          add('agents', 'attention', a.path, 'Shipped agent ' + a.name + ' carries no myicor_id.',
            'Run the hiring SOP step or `mint-agent-ids.py --map` with the scaffold\'s export, so ' + a.name + ' receives the id the scaffold knows it by: ' + a.myicor_id + '.');
        } else {
          add('agents', 'attention', a.path, '`' + a.path + '` is a different agent than the shipped ' + a.name + ' (different id); the shipped one is missing.',
            'If this is your own agent, give it its own folder, then copy the shipped ' + a.name + ' in from the latest scaffold. Never change the id on either file to make them match.');
        }
      }
      /* case d: found nowhere; the file check reports the canonical path missing, as before */
    }
  }

  /* rule 2: every local contract, shipped or the member's own */
  const byId = new Map();
  for (const c of contracts) {
    if (claimed.has(c.path)) continue;
    if (!c.id) {
      add('agents', 'attention', c.path, 'Agent contract carries no myicor_id.', MINT_FIX);
    } else if (c.id === NIL_ID) {
      if (!isTemplateName(c.name) && !isTemplateName(c.folder)) {
        add('agents', 'attention', c.path, 'Carries the nil placeholder id but is not a template (templates are named `Agent ...` or start with `_`).', MINT_FIX);
      }
    } else if (!UUID_V4.test(c.id)) {
      add('agents', 'attention', c.path, 'myicor_id `' + c.id + '` is not a lowercase UUID v4.',
        'If this is a shipped agent, take its id from the scaffold\'s export via `mint-agent-ids.py --map`; otherwise mint a fresh one. Never guess a correction by hand.');
    } else {
      if (!byId.has(c.id)) byId.set(c.id, []);
      byId.get(c.id).push(c.path);
    }
  }
  for (const [id, paths] of byId) {
    if (paths.length < 2) continue;
    add('agents', 'broken', paths[0], 'Two contracts share one myicor_id `' + id + '`: ' + paths.map((p) => '`' + p + '`').join(' and ') + '.',
      'One identity, one agent. Keep the id on the contract that was hired with it and mint a fresh id for the other; never reuse an id.');
  }
  return skipMissing;
}

/*
 * runChecks({ fs, hash, remote, local, installedVersion, configDir })
 *
 *   fs.exists(path) -> bool, fs.read(path) -> string, fs.readBinary(path)
 *   -> ArrayBuffer|Buffer, fs.listBases() -> [paths of every .base outside
 *   .obsidian], fs.listAgentContracts() -> [every 06 AI Team/Agents/<Name>/
 *   AGENT.md], fs.listShims() -> [every .claude/agents/<slug>.md]  (all async)
 *   hash(bytes) -> hex sha256 (async)
 *   remote: the latest manifest (parsed). local: the vault's own manifest or
 *   null. installedVersion: the VERSION file's content or null. configDir:
 *   the vault's config folder (`app.vault.configDir`), default `.obsidian`;
 *   a device on a config-folder profile keeps its plugins elsewhere.
 *
 * Returns { health, installedVersion, latestVersion, findings, counts }.
 * A finding: { kind, severity, path, message, action, since? }.
 * severity: 'broken' (structure the vault relies on is gone), 'attention'
 * (something to do), 'info' (worth knowing, nothing to do).
 */
async function runChecks({ fs, hash, remote, local, installedVersion, configDir }) {
  const cfg = (configDir || '.obsidian').replace(/\/+$/, '');
  const findings = [];
  const add = (kind, severity, path, message, action, extra) =>
    findings.push(Object.assign({ kind, severity, path, message, action }, extra || {}));

  if (!remote || typeof remote !== 'object' || !Array.isArray(remote.files)) {
    throw new Error('the latest manifest is not a scaffold manifest');
  }
  const latest = remote.version || null;
  const installed = installedVersion || (local && local.version) || null;

  /* 1. the version gap */
  if (!installed) {
    add('version', 'info', META_DIR + '/VERSION',
      'This vault does not carry a scaffold version, so every removal in the scaffold\'s history is treated as possibly still here.',
      'Add `.icor-for-life/VERSION` with the version you installed, or update to the latest scaffold and take its version folder.');
  } else if (compareVersions(installed, latest) < 0) {
    add('version', 'attention', META_DIR + '/VERSION',
      'Installed ' + installed + ', latest ' + latest + '.',
      'Read the changelog for every version after ' + installed + ' before updating; the leftover findings below are the parts that need a hand.');
  } else if (compareVersions(installed, latest) > 0) {
    add('version', 'info', META_DIR + '/VERSION',
      'Installed ' + installed + ' is newer than the latest published ' + latest + '.',
      'Nothing to do; you are ahead of the manifest this check fetched.');
  }

  /* 2. rooms: the folders the scaffold relies on */
  for (const room of remote.rooms || []) {
    if (!(await fs.exists(room))) {
      add('room', 'broken', room, 'Required folder is missing.', 'Create it. The scaffold and its plugins write here and will fail without it.');
    }
  }

  /* 3. agent identities (before the files, because a shipped agent found by
     its id under another name must not be reported missing below) */
  const foundElsewhere = await checkAgents({ fs, remote, add });

  /* 4. canonical files: three-way */
  const localHashes = new Map((local && local.files || []).map((f) => [f.path, f.sha256]));
  for (const f of remote.files || []) {
    const fk = { fileKind: f.kind || 'file' };
    const exists = await fs.exists(f.path);
    if (!exists) {
      if (f.example) continue; /* example notes are meant to be deleted */
      if (foundElsewhere.has(f.path)) continue; /* the agent lives under the member's own name */
      add('file', 'attention', f.path, 'Canonical ' + f.kind + ' is missing.', 'Copy it in from the latest scaffold.', fk);
      continue;
    }
    let have;
    try { have = await hash(await fs.readBinary(f.path)); } catch (e) { have = null; }
    if (have === f.sha256) continue;
    const installedHash = localHashes.get(f.path);
    if (installedHash && have === installedHash) {
      add('file', 'attention', f.path, 'Changed upstream since you installed; your copy is the version you started with.',
        'Update it from the latest scaffold. Safe: you never edited it.', fk);
    } else if (installedHash && installedHash !== f.sha256) {
      add('file', 'info', f.path, 'You edited this file, and it also changed upstream.',
        'Keep yours. Compare against the latest scaffold by hand if you want the upstream change too. This check never overwrites an edited file.', fk);
    } else if (installedHash) {
      add('file', 'info', f.path, 'You edited this file.', 'Keep it. It is yours now.', fk);
    } else {
      add('file', 'info', f.path, 'Differs from the latest scaffold, and without your installed manifest the check cannot tell whether you changed it or the scaffold did.',
        'Compare by hand, or add `.icor-for-life/manifest.json` from the version you installed so the next check can tell.', fk);
    }
  }

  /* 5. leftovers: removed or moved upstream after your version, still here.
     Matched by CONTENT when the manifest knows the old file's hash: a file
     that shares the old name but not the old bytes is the user's own, and
     is reported as a name collision, never as a leftover. */
  for (const r of removalsSince(remote, installed)) {
    if (!(await fs.exists(r.path))) continue;
    let same = true;
    if (r.sha256) {
      let have = null;
      try { have = await hash(await fs.readBinary(r.path)); } catch (e) { have = null; }
      same = have === r.sha256;
    }
    if (same) {
      add('leftover', 'attention', r.path,
        'Removed from the scaffold in ' + r.version + (r.note ? ': ' + r.note : '.'),
        'Delete it after reading the ' + r.version + ' changelog entry. Nothing in the scaffold reads it any more.', { since: r.version });
    } else {
      add('collision', 'info', r.path,
        'Shares its name with a scaffold file that was ' + (r.to ? 'renamed to `' + r.to + '`' : 'removed') + ' in ' + r.version + ', but not its content, so it is yours.',
        'Keep it. Nothing to do' + (r.to ? '; the scaffold\'s own document now lives at `' + r.to + '`.' : '.'), { since: r.version });
    }
  }

  /* 6. bases: every Base in the vault points at a folder that exists */
  for (const p of await fs.listBases()) {
    let txt = '';
    try { txt = await fs.read(p); } catch (e) { continue; }
    for (const folder of baseFolders(txt)) {
      if (!(await fs.exists(folder))) {
        add('base', 'broken', p, 'Filters on `' + folder + '`, which does not exist, so the Base lists nothing.',
          'Repoint the filter at the folder that replaced it, or delete the Base.');
      }
    }
  }

  /* 7. plugins the vault expects */
  let enabled = [];
  try { enabled = JSON.parse(await fs.read(cfg + '/community-plugins.json')); } catch (e) { enabled = []; }
  for (const id of remote.plugins || []) {
    const installed = await fs.exists(cfg + '/plugins/' + id + '/manifest.json');
    if (!installed) add('plugin', 'attention', cfg + '/plugins/' + id, 'Plugin is not installed.', 'Install it from the latest scaffold or the community list; the vault is built to have it.');
    else if (!enabled.includes(id)) add('plugin', 'attention', cfg + '/plugins/' + id, 'Plugin is installed but not enabled.', 'Enable it under Settings, Community plugins.');
  }

  /* 8. snippets enabled but gone (the reverse of a leftover) */
  let appearance = {};
  try { appearance = JSON.parse(await fs.read(cfg + '/appearance.json')); } catch (e) { appearance = {}; }
  for (const s of appearance.enabledCssSnippets || []) {
    if (!(await fs.exists(cfg + '/snippets/' + s + '.css'))) {
      add('snippet', 'attention', cfg + '/snippets/' + s + '.css', 'Enabled in appearance.json but the file is gone.',
        'Disable it under Settings, Appearance, CSS snippets. The scaffold no longer ships it.');
    }
  }
  if (Array.isArray(remote.snippets) && remote.snippets.length === 0 && (appearance.enabledCssSnippets || []).length) {
    add('snippet', 'info', cfg + '/appearance.json', 'The latest scaffold enables no CSS snippets; this vault enables ' + appearance.enabledCssSnippets.length + '.',
      'If they are the scaffold\'s old snippets, disable them; their rules live in the theme now.');
  }

  const counts = { broken: 0, attention: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const health = counts.broken ? 'broken' : counts.attention ? 'attention' : 'ok';
  return { health, installedVersion: installed, latestVersion: latest, findings, counts };
}

/* The report note. Frontmatter carries the numbers so a Base or a script can
   read it; the body is for the person, grouped by what to do. */
function renderReport(result, opts) {
  const o = Object.assign({ now: new Date(), manifestUrl: '', vaultName: '' }, opts || {});
  const stamp = o.now.toISOString().slice(0, 10);
  const L = [];
  L.push('---');
  L.push('type: scaffold-check');
  L.push('date: ' + stamp);
  L.push('health: ' + result.health);
  L.push('installed_version: ' + (result.installedVersion || 'unknown'));
  L.push('latest_version: ' + (result.latestVersion || 'unknown'));
  L.push('broken: ' + result.counts.broken);
  L.push('attention: ' + result.counts.attention);
  L.push('info: ' + result.counts.info);
  L.push('---');
  L.push('');
  L.push('# Scaffold Check, ' + stamp);
  L.push('');
  const verdict = result.health === 'ok' ? 'Everything the scaffold relies on is present and current.'
    : result.health === 'broken' ? 'Something the scaffold relies on is missing. Fix the broken items first; the plugins and the AI Team assume they exist.'
    : 'Nothing is broken. There are things to do.';
  L.push('**' + verdict + '**');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push('| Installed version | ' + (result.installedVersion || 'unknown') + ' |');
  L.push('| Latest version | ' + (result.latestVersion || 'unknown') + ' |');
  L.push('| Broken | ' + result.counts.broken + ' |');
  L.push('| Attention | ' + result.counts.attention + ' |');
  L.push('| Info | ' + result.counts.info + ' |');
  L.push('');
  L.push('Read-only: this check changed nothing. Your own files, the ones the scaffold never shipped, are not counted.');
  L.push('');

  const groups = [
    ['broken', 'Broken', 'Structure the scaffold relies on. Fix these first.'],
    ['attention', 'Attention', 'Things to do, in the order they appear.'],
    ['info', 'Info', 'Worth knowing. Nothing to do unless you want to.'],
  ];
  for (const [sev, title, lead] of groups) {
    const rows = result.findings.filter((f) => f.severity === sev);
    if (!rows.length) continue;
    L.push('## ' + title + ' (' + rows.length + ')');
    L.push('');
    L.push(lead);
    L.push('');
    /* Grouped by kind, so seventy missing files read as "6 guidelines, 13
       SOPs" with the list under each, rather than seventy lines. Order is
       the order the kinds first appear in, which is the manifest's order. */
    const groupOf = (f) => (f.kind === 'file' ? f.fileKind || 'file' : f.kind);
    const kinds = [];
    for (const f of rows) if (!kinds.includes(groupOf(f))) kinds.push(groupOf(f));
    for (const kind of kinds) {
      const sub = rows.filter((f) => groupOf(f) === kind);
      if (kinds.length > 1) { L.push('### ' + kind + ' (' + sub.length + ')'); L.push(''); }
      for (const f of sub) {
        L.push('- **`' + f.path + '`** ' + f.message);
        L.push('  - Do: ' + f.action);
      }
      L.push('');
    }
  }

  L.push('## For your AI');
  L.push('');
  L.push('Paste this into your AI session to have the fixes done for you. Everything above is the input; nothing here changes a file on its own.');
  L.push('');
  L.push('```');
  L.push('Read the Scaffold Check report at the path of this note. Fix every Broken item, then every Attention item, in order. Rules: never overwrite a file the report says I edited; for a leftover, delete it only after reading the changelog line the report cites; for a missing canonical file, copy it from the latest ICOR for Life Scaffold; never change or reuse a `myicor_id`, an agent keeps its id for life. Show me each change before you make it.');
  L.push('```');
  L.push('');
  if (o.manifestUrl) {
    L.push('Latest manifest: ' + o.manifestUrl);
    L.push('');
  }
  return L.join('\n');
}

const engine = { parseVersion, compareVersions, baseFolders, removalsSince, readFrontmatter, isTemplateName, runChecks, renderReport, META_DIR, AGENTS_DIR, NIL_ID, UUID_V4 };

/* ============================================= where the token lives ===== */
/*
 * The GitHub token (0.3.0). Two backends, one setting `secretsBackend`:
 *   - 'secret-storage': Obsidian's keychain (Settings, General, Keychain),
 *     `app.secretStorage`, present from Obsidian 1.11.4. Its three methods
 *     are synchronous: setSecret(id, value) (throws on a bad id),
 *     getSecret(id) (null when absent), listSecrets(). There is no delete;
 *     an entry is cleared by writing the empty string. Ids are lowercase
 *     letters, digits and dashes, and the store is shared by every plugin,
 *     hence the plugin-id prefix on SECRET_ID. Desktop keeps one encrypted
 *     blob per vault, mobile one per device; Obsidian Sync carries none of
 *     it, so each device holds its own copy of the token.
 *   - 'env-file': one `GITHUB_TOKEN=` line in a KEY=value file inside the
 *     vault, `06 AI Team/AI Team Knowledge/.env` by default. Comment lines
 *     start with `#`; a value runs to the end of its line, no quotes, no
 *     interpolation. Saving rewrites that one line and leaves every other
 *     byte of the file as it was.
 * The selected backend is the only one read at runtime. A fallback to the
 * other one would hide a misconfiguration behind a check that still works.
 * Everything in this section is pure (no Obsidian, no file system) and is
 * exported on module.exports.secrets so `node --test` can gate it.
 */

const SECRET_ID = 'icor-for-life-scaffold-check-github-token';
const ENV_KEY = 'GITHUB_TOKEN';
const DEFAULT_ENV_FILE = '06 AI Team/AI Team Knowledge/.env';
const BACKEND_STORE = 'secret-storage';
const BACKEND_ENV = 'env-file';

const ENV_KEY_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/* leading blanks, the key, blanks and the '=', the rest of the line */
const ENV_LINE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*)$/;

function trimmed(v) { return typeof v === 'string' ? v.trim() : ''; }

/* A vault-relative file path: forward slashes, no leading slash, no '~', no
   '..' segment. Obsidian's normalizePath() does not resolve a dot-dot
   segment, so without this a setting of '../x' would read and write outside
   the vault. Same shape as the Planner's. */
function normalizeEnvFilePath(v) {
  const raw = trimmed(v).replace(/\\/g, '/');
  if (!raw) return { ok: false, path: '', error: 'Enter a path inside the vault, for example ' + DEFAULT_ENV_FILE + '.' };
  if (/^([a-zA-Z]:)?\//.test(raw) || raw.startsWith('~')) return { ok: false, path: '', error: 'The path is relative to the vault root, not an absolute path.' };
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return { ok: false, path: '', error: 'The path must stay inside the vault (no "..").' };
  if (!parts.length) return { ok: false, path: '', error: 'Enter a file name, not a folder.' };
  return { ok: true, path: parts.join('/'), error: '' };
}

/* The text as pieces that each end at a newline (kept) or at the end of the
   string, so the pieces joined are the text byte for byte. A plain loop on
   purpose: a regex lookbehind literal is a parse-time SyntaxError on iOS
   before 16.4, and this plugin runs on mobile. */
function splitKeepingEndings(src) {
  const out = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) { out.push(src.slice(start, i + 1)); start = i + 1; }
  }
  if (start < src.length) out.push(src.slice(start));
  return out;
}

/* The file as lines that each keep their own terminator, so a rewrite puts
   every untouched line back byte for byte. */
function envLines(text) {
  const src = typeof text === 'string' ? text : '';
  if (src === '') return [];
  return splitKeepingEndings(src).map((raw) => {
    const body = raw.replace(/\r?\n$/, '');
    return { raw, body, eol: raw.slice(body.length), match: ENV_LINE.exec(body) };
  });
}

function assertEnvKey(key) {
  if (!ENV_KEY_SHAPE.test(String(key))) throw new Error('not an env key name');
}

/* The value of `key`, '' when the file has no such line. When a key appears
   more than once the last line wins, which is also the line the writer
   rewrites, so what is read is always what was last saved. */
function readEnvValue(text, key) {
  assertEnvKey(key);
  let value = '';
  for (const l of envLines(text)) if (l.match && l.match[2] === key) value = l.match[4].trim();
  return value;
}

/* The file with `key` set to `value`: the last `key=` line rewritten in
   place (its indentation and its spacing before the '=' kept, its
   terminator kept), or one line appended when there is none. Appending to a
   file whose last line has no terminator first ends that line, with the
   terminator the file already uses. Clearing (an empty value) blanks the
   line to `KEY=` and keeps it; clearing a key the file does not have
   returns the text unchanged. Idempotent: writing the same value twice is
   the same file. A value with a line break is refused, since it would
   become a second line. */
function writeEnvValue(text, key, value) {
  assertEnvKey(key);
  const src = typeof text === 'string' ? text : '';
  const v = trimmed(value);
  if (/[\r\n]/.test(v)) throw new Error('a value cannot contain a line break');
  const lines = envLines(src);
  let last = -1;
  lines.forEach((l, i) => { if (l.match && l.match[2] === key) last = i; });
  if (last >= 0) {
    const m = lines[last].match;
    lines[last].raw = m[1] + m[2] + m[3] + v + lines[last].eol;
    return lines.map((l) => l.raw).join('');
  }
  if (!v) return src;
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const open = src !== '' && !src.endsWith('\n');
  return src + (open ? eol : '') + key + '=' + v + eol;
}

/* Which backend is in use: the saved choice when it can be honoured, the
   keychain by default when this Obsidian has one, the env file otherwise.
   A saved 'secret-storage' on a device without the store reads the env
   file, and the settings tab says so; the choice itself is left as saved,
   so a data.json shared through Sync keeps the other device's answer. */
function resolveBackend(saved, storeAvailable) {
  if (saved === BACKEND_ENV) return BACKEND_ENV;
  return storeAvailable ? BACKEND_STORE : BACKEND_ENV;
}

/* Feature detection on the two methods this plugin calls, never a version
   compare: the store is what it can do. */
function secretStorageUsable(storage) {
  return !!(storage && typeof storage.getSecret === 'function' && typeof storage.setSecret === 'function');
}

class SecretStore {
  constructor(storage) { this.storage = secretStorageUsable(storage) ? storage : null; }
  available() { return !!this.storage; }
  /* '' when absent, unreadable or cleared; never null, never a throw. */
  get(id) {
    if (!this.storage) return '';
    try { return trimmed(this.storage.getSecret(id)); } catch (e) { return ''; }
  }
  /* true when the store holds the value now. false means the caller must
     leave the value where it was. */
  set(id, value) {
    if (!this.storage) return false;
    const v = trimmed(value);
    if (!v) return this.clear(id);
    try { this.storage.setSecret(id, v); return true; } catch (e) { return false; }
  }
  clear(id) {
    if (!this.storage) return false;
    if (this.get(id) === '') return true;
    try { this.storage.setSecret(id, ''); return true; } catch (e) { return false; }
  }
}

/* On load, in secret-storage mode only: a token still in data.json moves
   into the store and the field is blanked, in place. Never the other way
   round, and never into the env file, on its own; the settings tab has a
   button for that. Returns true when data.json must be saved. Idempotent:
   a second call moves nothing. A store that refuses the value leaves the
   field as it was, so a blank is written only after the token has a home. */
function migrateToken(settings, store, backend) {
  const s = settings || {};
  const v = trimmed(s.githubToken);
  if (!v) return false;
  if (backend !== BACKEND_STORE || !store || !store.set(SECRET_ID, v)) return false;
  s.githubToken = '';
  return true;
}

const secrets = { SECRET_ID, ENV_KEY, DEFAULT_ENV_FILE, BACKEND_STORE, BACKEND_ENV, readEnvValue, writeEnvValue, resolveBackend, secretStorageUsable, SecretStore, migrateToken, normalizeEnvFilePath, splitKeepingEndings };

/* ======================================================= the plugin ===== */

if (obsidian) {
  const { Plugin, PluginSettingTab, Setting, Notice, Modal, requestUrl, normalizePath } = obsidian;

  const DEFAULTS = {
    manifestUrl: DEFAULT_MANIFEST_URL,
    /* '' means "the default for this Obsidian": the keychain when it has
       one, the env file otherwise. resolveBackend() answers each time. */
    secretsBackend: '',
    envFilePath: DEFAULT_ENV_FILE,
    /* Kept only so a token saved by 0.2.0 can be found and moved out. Blank
       from the first load of 0.3.0 in keychain mode; see migrateToken. */
    githubToken: '',
    runOnStartup: true,
    writeReport: true,
    reportFolder: DEFAULT_REPORT_FOLDER,
    lastRun: null,
    lastHealth: 'unknown',
  };

  /* sha256 over the vault's bytes via Web Crypto: present on desktop and mobile. */
  async function sha256Hex(bytes) {
    const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* The vault as the engine sees it. The adapter is used rather than the
     TFile tree because `.icor-for-life/` and `.obsidian/` are dot-folders,
     which the file index does not hold. */
  function vaultFs(app) {
    const adapter = app.vault.adapter;
    return {
      exists: (p) => adapter.exists(normalizePath(p)),
      read: (p) => adapter.read(normalizePath(p)),
      readBinary: (p) => adapter.readBinary(normalizePath(p)),
      listBases: async () => app.vault.getFiles().filter((f) => f.extension === 'base' && !f.path.startsWith(app.vault.configDir + '/')).map((f) => f.path),
      listAgentContracts: async () => {
        const dir = normalizePath(AGENTS_DIR);
        if (!(await adapter.exists(dir))) return [];
        const out = [];
        for (const folder of (await adapter.list(dir)).folders) {
          const p = normalizePath(folder + '/AGENT.md');
          if (await adapter.exists(p)) out.push(p);
        }
        return out;
      },
      listShims: async () => {
        const dir = normalizePath('.claude/agents');
        if (!(await adapter.exists(dir))) return [];
        return (await adapter.list(dir)).files.filter((p) => p.endsWith('.md')).map((p) => normalizePath(p));
      },
    };
  }

  class ScaffoldCheckPlugin extends Plugin {
    async onload() {
      this.settings = Object.assign({}, DEFAULTS, (await this.loadData()) || {});
      /* A hand-edited data.json cannot point outside the vault either. */
      this.settings.envFilePath = normalizeEnvFilePath(this.settings.envFilePath).path || DEFAULT_ENV_FILE;
      this.lastResult = null;
      this.store = new SecretStore(this.app.secretStorage);
      if (migrateToken(this.settings, this.store, this.backend())) await this.saveData(this.settings);

      this.statusEl = this.addStatusBarItem();
      this.statusEl.addClass('icor-scaffold-status');
      this.statusEl.addEventListener('click', () => this.showResult());
      this.paintStatus(this.settings.lastHealth || 'unknown');

      this.addRibbonIcon('shield-check', 'Scaffold Check', () => this.run({ interactive: true }));
      this.addCommand({ id: 'run', name: 'Run the Scaffold Check', callback: () => this.run({ interactive: true }) });
      this.addCommand({ id: 'show', name: 'Show the last Scaffold Check result', callback: () => this.showResult() });
      this.addSettingTab(new ScaffoldCheckSettingTab(this.app, this));

      if (this.settings.runOnStartup) {
        this.app.workspace.onLayoutReady(() => { this.run({ interactive: false }); });
      }
    }

    paintStatus(health) {
      const el = this.statusEl;
      el.empty();
      const dot = el.createSpan({ cls: 'icor-scaffold-dot icor-scaffold-dot-' + health });
      dot.setAttribute('aria-hidden', 'true');
      el.createSpan({ text: STATUS_TEXT[health] || STATUS_TEXT.unknown });
      el.setAttribute('aria-label', STATUS_TEXT[health] || STATUS_TEXT.unknown);
    }

    async readLocal() {
      const fs = vaultFs(this.app);
      let installedVersion = null, local = null;
      try { if (await fs.exists(META_DIR + '/VERSION')) installedVersion = String(await fs.read(META_DIR + '/VERSION')).trim(); } catch (e) { installedVersion = null; }
      try { if (await fs.exists(META_DIR + '/manifest.json')) local = JSON.parse(await fs.read(META_DIR + '/manifest.json')); } catch (e) { local = null; }
      return { fs, installedVersion, local };
    }

    async fetchRemote() {
      const url = (this.settings.manifestUrl || '').trim();
      if (!url) throw new Error('no manifest URL is set');
      const headers = { Accept: 'application/json' };
      const token = await this.readToken();
      if (token) headers.Authorization = 'Bearer ' + token;
      const resp = await requestUrl({ url, headers, throw: false });
      if (resp.status !== 200) throw new Error('HTTP ' + resp.status + ' fetching the latest manifest');
      const data = typeof resp.json === 'object' && resp.json ? resp.json : JSON.parse(resp.text);
      /* The GitHub contents API wraps the file in base64; unwrap it so an API
         URL works as well as a raw one. */
      if (data && data.encoding === 'base64' && typeof data.content === 'string') {
        return JSON.parse(atob(data.content.replace(/\n/g, '')));
      }
      return data;
    }

    async run({ interactive }) {
      this.paintStatus('unknown');
      let remote;
      try {
        remote = await this.fetchRemote();
      } catch (e) {
        this.paintStatus('offline');
        this.settings.lastHealth = 'offline';
        await this.saveData(this.settings);
        if (interactive) new Notice('Scaffold Check: could not fetch the latest manifest (' + e.message + '). Check the URL and token in settings.');
        return null;
      }
      const { fs, installedVersion, local } = await this.readLocal();
      let result;
      try {
        result = await engine.runChecks({ fs, hash: sha256Hex, remote, local, installedVersion, configDir: this.app.vault.configDir });
      } catch (e) {
        this.paintStatus('offline');
        if (interactive) new Notice('Scaffold Check failed: ' + e.message);
        return null;
      }
      this.lastResult = result;
      this.paintStatus(result.health);
      this.settings.lastHealth = result.health;
      this.settings.lastRun = new Date().toISOString();
      await this.saveData(this.settings);

      if (this.settings.writeReport) {
        try { await this.writeReport(result); } catch (e) { if (interactive) new Notice('Scaffold Check: could not write the report (' + e.message + ')'); }
      }
      if (interactive) this.showResult();
      else if (result.health !== 'ok') new Notice('Scaffold Check: ' + result.counts.broken + ' broken, ' + result.counts.attention + ' to do. Click the status bar for the report.');
      return result;
    }

    /* ---- the token: one backend at a time, never a fallback ---- */

    backend() { return resolveBackend(this.settings.secretsBackend, this.store.available()); }
    envPath() { return normalizePath(normalizeEnvFilePath(this.settings.envFilePath).path || DEFAULT_ENV_FILE); }

    /* The env file's text, or null when there is no such file. */
    async readEnvFile() {
      const adapter = this.app.vault.adapter;
      const p = this.envPath();
      if (!(await adapter.exists(p))) return null;
      return String(await adapter.read(p));
    }

    /* The token from the selected backend, '' when it holds none. The other
       backend and data.json are never consulted here. */
    async readToken() {
      if (this.backend() === BACKEND_STORE) return this.store.get(SECRET_ID);
      const text = await this.readEnvFile();
      return text == null ? '' : readEnvValue(text, ENV_KEY);
    }

    /* Write (or, with '', clear) the token in one backend, the selected one
       unless named. The env file is rewritten only when its bytes change. */
    async writeToken(value, backend) {
      const target = backend || this.backend();
      if (target === BACKEND_STORE) {
        if (!this.store.available()) throw new Error('this Obsidian has no keychain');
        if (!this.store.set(SECRET_ID, value)) throw new Error('Obsidian\'s keychain did not accept the value');
        return;
      }
      const adapter = this.app.vault.adapter;
      const p = this.envPath();
      const text = (await adapter.exists(p)) ? String(await adapter.read(p)) : '';
      const next = writeEnvValue(text, ENV_KEY, value);
      if (next !== text) await adapter.write(p, next);
    }

    /* Where a token exists right now, for the settings tab. */
    async tokenLocations() {
      const text = await this.readEnvFile();
      return {
        store: this.store.get(SECRET_ID) !== '',
        env: text != null && readEnvValue(text, ENV_KEY) !== '',
        dataJson: trimmed(this.settings.githubToken) !== '',
      };
    }

    /* Copy the token from one place into the selected backend, then blank the
       place it came from. The old copy is blanked only after the new one is
       written, so a failed write leaves the token where it was. */
    async moveToken(from) {
      const target = this.backend();
      if (from === 'data-json') {
        const v = trimmed(this.settings.githubToken);
        if (!v) return;
        await this.writeToken(v, target);
        this.settings.githubToken = '';
        await this.saveData(this.settings);
        return;
      }
      if (from === target) return;
      if (from === BACKEND_STORE) {
        const v = this.store.get(SECRET_ID);
        if (!v) return;
        await this.writeToken(v, target);
        if (!this.store.clear(SECRET_ID)) throw new Error('the keychain kept its copy');
        return;
      }
      if (from === BACKEND_ENV) {
        const text = await this.readEnvFile();
        const v = text == null ? '' : readEnvValue(text, ENV_KEY);
        if (!v) return;
        await this.writeToken(v, target);
        await this.writeToken('', BACKEND_ENV);
      }
    }

    async writeReport(result) {
      const folder = normalizePath(this.settings.reportFolder || DEFAULT_REPORT_FOLDER);
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
      const stamp = new Date().toISOString().slice(0, 10);
      const path = normalizePath(folder + '/' + stamp + '-scaffold-check.md');
      const text = engine.renderReport(result, { manifestUrl: this.settings.manifestUrl });
      await adapter.write(path, text);
      this.lastReportPath = path;
    }

    showResult() {
      if (!this.lastResult) { new Notice('Scaffold Check has not run yet. Run it from the ribbon or the command palette.'); return; }
      new ResultModal(this.app, this).open();
    }
  }

  class ResultModal extends Modal {
    constructor(app, plugin) { super(app); this.plugin = plugin; }
    onOpen() {
      const r = this.plugin.lastResult;
      const c = this.contentEl;
      c.empty();
      c.addClass('icor-scaffold-modal');
      c.createEl('h2', { text: 'Scaffold Check' });
      const head = c.createDiv({ cls: 'icor-scaffold-head' });
      head.createSpan({ cls: 'icor-scaffold-dot icor-scaffold-dot-' + r.health });
      head.createSpan({ text: STATUS_TEXT[r.health] });
      const meta = c.createEl('p', { cls: 'icor-scaffold-meta' });
      meta.setText('Installed ' + (r.installedVersion || 'unknown') + ' · latest ' + (r.latestVersion || 'unknown') + ' · ' + r.counts.broken + ' broken · ' + r.counts.attention + ' attention · ' + r.counts.info + ' info');
      for (const sev of ['broken', 'attention', 'info']) {
        const rows = r.findings.filter((f) => f.severity === sev);
        if (!rows.length) continue;
        c.createEl('h3', { text: sev[0].toUpperCase() + sev.slice(1) + ' (' + rows.length + ')' });
        const ul = c.createEl('ul');
        for (const f of rows.slice(0, 40)) {
          const li = ul.createEl('li');
          li.createEl('code', { text: f.path });
          li.createSpan({ text: ' ' + f.message });
        }
        if (rows.length > 40) c.createEl('p', { text: (rows.length - 40) + ' more in the report.' });
      }
      const foot = c.createDiv({ cls: 'icor-scaffold-foot' });
      if (this.plugin.lastReportPath) {
        const b = foot.createEl('button', { text: 'Open the report' });
        b.addEventListener('click', () => { this.app.workspace.openLinkText(this.plugin.lastReportPath, '', true); this.close(); });
      }
      const again = foot.createEl('button', { text: 'Run again' });
      again.addEventListener('click', () => { this.close(); this.plugin.run({ interactive: true }); });
    }
    onClose() { this.contentEl.empty(); }
  }

  /* The settings tab. The token row is a password input plus Save: the input
     is cleared once the value has a home, and the row under it says where a
     token is right now (the keychain, the env file, still in data.json) with
     a button to move it into the backend in use. No value is ever shown,
     echoed in a notice, or logged, not even masked. */
  const BACKEND_LABEL = { [BACKEND_STORE]: 'Obsidian\'s keychain', [BACKEND_ENV]: 'the env file' };

  class ScaffoldCheckSettingTab extends PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
    display() {
      const c = this.containerEl;
      c.empty();
      c.createEl('p', { text: 'Read-only. Compares this vault with the latest ICOR for Life Scaffold and writes a report. It never changes a scaffold file.' });
      const s = this.plugin.settings;
      const plugin = this.plugin;
      const save = () => plugin.saveData(s);
      const storeOk = plugin.store.available();
      const backend = plugin.backend();
      const label = BACKEND_LABEL[backend];

      new Setting(c).setName('Latest manifest URL')
        .setDesc('Where the latest scaffold\'s .icor-for-life/manifest.json is published. A raw file URL or a GitHub contents API URL.')
        .addText((t) => t.setValue(s.manifestUrl).setPlaceholder(DEFAULT_MANIFEST_URL).onChange(async (v) => { s.manifestUrl = v.trim(); await save(); }));

      new Setting(c).setName('Where your keys live')
        .setDesc(storeOk
          ? 'Obsidian\'s keychain (Settings, General, Keychain) keeps the token outside the vault and outside data.json; Obsidian Sync does not carry it, so each device holds its own copy. The env file is one GITHUB_TOKEN= line in a KEY=value file inside the vault. Only the backend chosen here is read. Changing it moves nothing by itself; use the button under the token.'
          : 'This Obsidian has no keychain (1.11.4 or newer has one), so the env file is the only choice: one GITHUB_TOKEN= line in a KEY=value file inside the vault.')
        .addDropdown((d) => {
          d.addOption(BACKEND_STORE, 'Obsidian\'s keychain');
          d.addOption(BACKEND_ENV, 'An env file in the vault');
          d.setValue(backend);
          d.setDisabled(!storeOk);
          d.onChange(async (v) => { s.secretsBackend = v === BACKEND_ENV ? BACKEND_ENV : BACKEND_STORE; await save(); this.display(); });
        });
      const envDesc = 'Path of the key=value file, relative to the vault root; an absolute path or a ".." segment is refused. Only the token line is ever written; every other line stays exactly as it is.';
      const envRow = new Setting(c).setName('Env file')
        .setDesc(envDesc)
        .addText((t) => t.setValue(s.envFilePath).setPlaceholder(DEFAULT_ENV_FILE).onChange(async (v) => {
          /* An empty field means the default. A path that leaves the vault is
             refused, shown in place, and not saved. */
          const n = normalizeEnvFilePath(trimmed(v) || DEFAULT_ENV_FILE);
          envRow.descEl.toggleClass('is-failed', !n.ok);
          envRow.setDesc(n.ok ? envDesc : n.error);
          if (!n.ok) return;
          s.envFilePath = n.path; await save(); this.renderTokenStatus();
        }));

      let pending = '';
      let input = null;
      new Setting(c).setName('GitHub token (optional)')
        .setDesc('Only needed when the manifest URL is on a private repository. Saved to ' + label + ', sent only to the manifest URL\'s host, never written anywhere else. The field is cleared once the token is saved; the line below says where it is.')
        .addText((t) => {
          input = t;
          t.inputEl.type = 'password';
          t.inputEl.setAttribute('autocomplete', 'off');
          t.inputEl.setAttribute('aria-label', 'GitHub token');
          t.setPlaceholder('Paste the token, then save it').onChange((v) => { pending = v; });
        })
        .addButton((b) => b.setButtonText('Save').setCta().onClick(async () => {
          const v = pending.trim();
          if (!v) { new Notice('Scaffold Check: paste a token first. To forget the saved one, use the remove button.'); return; }
          try { await plugin.writeToken(v); } catch (e) { new Notice('Scaffold Check: the token could not be saved, so nothing changed. Check that it is one line and that the env file path is inside the vault.'); return; }
          pending = '';
          if (input) input.setValue('');
          new Notice('Scaffold Check: token saved to ' + label + '.');
          await this.renderTokenStatus();
        }));
      this.statusBox = c.createDiv();
      this.renderTokenStatus();

      new Setting(c).setName('Run on startup')
        .setDesc('Check once when the vault opens and show the result in the status bar.')
        .addToggle((t) => t.setValue(s.runOnStartup).onChange(async (v) => { s.runOnStartup = v; await save(); }));
      new Setting(c).setName('Write the report note')
        .setDesc('One note per day in the report folder, overwritten on each run that day.')
        .addToggle((t) => t.setValue(s.writeReport).onChange(async (v) => { s.writeReport = v; await save(); }));
      new Setting(c).setName('Report folder')
        .addText((t) => t.setValue(s.reportFolder).setPlaceholder(DEFAULT_REPORT_FOLDER).onChange(async (v) => { s.reportFolder = v.trim() || DEFAULT_REPORT_FOLDER; await save(); }));
      new Setting(c).setName('Run now').addButton((b) => b.setButtonText('Run the Scaffold Check').setCta().onClick(() => plugin.run({ interactive: true })));
      if (s.lastRun) c.createEl('p', { cls: 'icor-scaffold-meta', text: 'Last run ' + s.lastRun + ' · ' + (STATUS_TEXT[s.lastHealth] || '') });
    }

    /* One row: where a token exists right now, and a Move button for each
       place that is not the backend in use, Remove for the one that is.
       Rebuilt after every save and move, since the answer changed. */
    async renderTokenStatus() {
      const box = this.statusBox;
      if (!box) return;
      const plugin = this.plugin;
      const backend = plugin.backend();
      const label = BACKEND_LABEL[backend];
      let where;
      try { where = await plugin.tokenLocations(); } catch (e) { where = { store: false, env: false, dataJson: false, error: e.message }; }
      box.empty();
      const row = new Setting(box).setName('Where the token is');
      const lines = [];
      if (where.store) lines.push('Stored in Obsidian\'s keychain' + (backend === BACKEND_STORE ? ' (in use).' : ' (not read while the env file is selected).'));
      if (where.env) lines.push('Stored in the env file, ' + plugin.envPath() + (backend === BACKEND_ENV ? ' (in use).' : ' (not read while the keychain is selected).'));
      if (where.dataJson) lines.push('Still in this plugin\'s data.json, in plain text (not read). Move it.');
      if (!lines.length) lines.push(where.error ? 'Could not read the env file (' + where.error + ').' : 'Not set. The manifest URL is fetched without a token.');
      row.setDesc(lines.join(' '));
      const move = (from) => row.addButton((b) => b.setButtonText('Move to ' + label).onClick(async () => {
        try { await plugin.moveToken(from); } catch (e) { new Notice('Scaffold Check: the token could not be moved, so it stays where it was.'); return; }
        new Notice('Scaffold Check: token moved to ' + label + '.');
        await this.renderTokenStatus();
      }));
      if (where.dataJson) move('data-json');
      if (where.store && backend !== BACKEND_STORE) move(BACKEND_STORE);
      if (where.env && backend !== BACKEND_ENV) move(BACKEND_ENV);
      const inUse = backend === BACKEND_STORE ? where.store : where.env;
      if (inUse) row.addButton((b) => b.setButtonText('Remove').setWarning().onClick(async () => {
        try { await plugin.writeToken(''); } catch (e) { new Notice('Scaffold Check: the token could not be removed and is still in place.'); return; }
        new Notice('Scaffold Check: token removed from ' + label + '.');
        await this.renderTokenStatus();
      }));
    }
  }

  module.exports = ScaffoldCheckPlugin;
} else {
  module.exports = {};
}
module.exports.engine = engine;
module.exports.secrets = secrets;
