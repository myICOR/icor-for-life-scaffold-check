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
 * writes are the report note and its own data.json. Files the scaffold never
 * shipped are yours and are not counted; extra is not drift.
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

/* ======================================================= the plugin ===== */

if (obsidian) {
  const { Plugin, PluginSettingTab, Setting, Notice, Modal, requestUrl, normalizePath } = obsidian;

  const DEFAULTS = {
    manifestUrl: DEFAULT_MANIFEST_URL,
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
      this.lastResult = null;

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
      if (this.settings.githubToken) headers.Authorization = 'Bearer ' + this.settings.githubToken.trim();
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

  class ScaffoldCheckSettingTab extends PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
    display() {
      const c = this.containerEl;
      c.empty();
      c.createEl('p', { text: 'Read-only. Compares this vault with the latest ICOR for Life Scaffold and writes a report. It never changes a scaffold file.' });
      const s = this.plugin.settings;
      const save = () => this.plugin.saveData(s);

      new Setting(c).setName('Latest manifest URL')
        .setDesc('Where the latest scaffold\'s .icor-for-life/manifest.json is published. A raw file URL or a GitHub contents API URL.')
        .addText((t) => t.setValue(s.manifestUrl).setPlaceholder(DEFAULT_MANIFEST_URL).onChange(async (v) => { s.manifestUrl = v.trim(); await save(); }));
      new Setting(c).setName('GitHub token (optional)')
        .setDesc('Only needed when the manifest URL is on a private repository. Stored in this plugin\'s data.json, sent only to the manifest URL\'s host, never written anywhere else.')
        .addText((t) => { t.inputEl.type = 'password'; t.setValue(s.githubToken).onChange(async (v) => { s.githubToken = v.trim(); await save(); }); });
      new Setting(c).setName('Run on startup')
        .setDesc('Check once when the vault opens and show the result in the status bar.')
        .addToggle((t) => t.setValue(s.runOnStartup).onChange(async (v) => { s.runOnStartup = v; await save(); }));
      new Setting(c).setName('Write the report note')
        .setDesc('One note per day in the report folder, overwritten on each run that day.')
        .addToggle((t) => t.setValue(s.writeReport).onChange(async (v) => { s.writeReport = v; await save(); }));
      new Setting(c).setName('Report folder')
        .addText((t) => t.setValue(s.reportFolder).setPlaceholder(DEFAULT_REPORT_FOLDER).onChange(async (v) => { s.reportFolder = v.trim() || DEFAULT_REPORT_FOLDER; await save(); }));
      new Setting(c).setName('Run now').addButton((b) => b.setButtonText('Run the Scaffold Check').setCta().onClick(() => this.plugin.run({ interactive: true })));
      if (s.lastRun) c.createEl('p', { cls: 'icor-scaffold-meta', text: 'Last run ' + s.lastRun + ' · ' + (STATUS_TEXT[s.lastHealth] || '') });
    }
  }

  module.exports = ScaffoldCheckPlugin;
} else {
  module.exports = {};
}
module.exports.engine = engine;
