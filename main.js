/*
 * ICOR for Life - Scaffold Check: is this vault up to date with the ICOR for
 * Life Scaffold, and is what it has still intact?
 *
 * Since 0.7.0 the one scaffold is two products: ICOR for Life (the content
 * vault, version folder `.icor-for-life/`) and myPKA (the AI team, version
 * folder `.mypka/`). A vault holds both (mode A), only the content (mode B,
 * the team in its own folder), or only the team (a team folder opened as a
 * vault). The check says which, checks what is here, and says in one line
 * that the other half lives elsewhere; it never calls it missing.
 *
 * What it does:
 *   1. Reads the vault's own version folders, `.icor-for-life/` and
 *      `.mypka/` (VERSION and manifest.json each), which say which release
 *      of each product this vault was copied from.
 *   2. Fetches the manifest of the LATEST release of each product from the
 *      URLs set in the settings: two outbound requests, the myPKA one only
 *      when its URL is set. Both manifest shapes are read (the list shape
 *      of 1.x, the map shape since the split; schema 1 and 2).
 *   3. Compares the two against the files actually on disk and reports:
 *        - the version gap;
 *        - every canonical file that is MISSING, CHANGED BY YOU, or CHANGED
 *          UPSTREAM since you installed (three answers, three actions);
 *        - LEFTOVERS: files the scaffold removed or moved after your version
 *          that are still here, each with the changelog line that explains it.
 *          A file one product stopped shipping because the OTHER product
 *          ships it now is a move, never a leftover;
 *        - structure: the rooms, the plugins the vault expects, every Base
 *          pointing at a folder that exists, every enabled snippet present;
 *        - AGENT IDENTITY: every agent contract carries a stable `myicor_id`
 *          (scaffold 1.11.0); shipped agents are found by that id, so a
 *          renamed agent is intact, not missing, and a contract without an
 *          id, with a malformed or placeholder one, or sharing one with
 *          another contract, is named.
 *        - the GENERATED HARNESS LAYER (scaffold 1.23.0): every file that
 *          carries `scaffold-init.py`'s header is judged by the content
 *          hash in that header, not against the scaffold's copy, because
 *          the generator writes it from THIS vault's frontmatter. Intact
 *          is nothing to do; a mismatch is a hand edit the next apply
 *          will overwrite. The fix is always the generator, never a copy
 *          and never a hand edit. `.agents/skills/` is per device: absent
 *          is not a finding, a link with no skill behind it is.
 *   4. Reads the KNOWLEDGE QUALITY numbers the scaffold's own script writes
 *      to `.icor-for-life/scripts/quality.json` (0.4.0) and shows them in
 *      the report and on a dashboard view, with a trend per metric from
 *      this plugin's own run history. The script measures; this plugin
 *      only reads.
 *      only reads. Reads the HARNESS the generator's `doctor --json`
 *      writes to `.icor-for-life/scripts/harness.json` (0.5.0) the same
 *      way: per host, what is detected, installed, trusted, tested and
 *      unsupported. Absent means the generator has not been asked, which
 *      is one sentence and not an error.
 *   5. Writes the report as a note the user can act on, or hand to their AI.
 *
 * What it never does: it never changes a scaffold file. The only things it
 * writes are the report note, its own data.json, its run history under
 * `.icor-for-life/icor-for-life-scaffold-check/` (regenerable, per device),
 * and, when the GitHub token is kept in an env file, that file's one
 * GITHUB_TOKEN line. Files the scaffold never shipped are yours and are not
 * counted; extra is not drift.
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
/* Obsidian's default config folder, as a manifest names it. The live vault's
   own is `app.vault.configDir`; a manifest path is always the default. */
const CONFIG_DIR = '.obsidian';
const DEFAULT_MANIFEST_URL =
  'https://raw.githubusercontent.com/TomSolid/icor-for-life-scaffold/main/.icor-for-life/manifest.json';
const DEFAULT_REPORT_FOLDER = '06 AI Team/AI Team Knowledge/Scaffold Check';
const STATUS_TEXT = { ok: 'Scaffold ok', attention: 'Scaffold: attention', broken: 'Scaffold: broken', offline: 'Scaffold: offline', unknown: 'Scaffold: not checked' };

/* ================================================== the local clock ===== */

/* A CALENDAR DAY IS NEVER THE FIRST TEN CHARACTERS OF AN INSTANT.
 * `toISOString()` renders in UTC, so slicing it answers "which day is it in
 * Greenwich", which is not the question anyone is asking of a note in their
 * own vault. West of UTC an evening run is dated tomorrow; east of it an
 * early-morning run is dated yesterday and overwrites the note already
 * sitting there. The instant is still the right thing to STORE, and
 * `lastRun` still stores one; it is only the day drawn out of it that has
 * to come from the wall clock. Ported from the Planner, which learned it
 * first. */

function pad2(n) { return String(n).padStart(2, '0'); }

/* The day a wall clock in this timezone is showing for `d`. */
function localDayStr(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* Today, here. */
function todayStr() { return localDayStr(new Date()); }

/* The local day of a STORED instant; '' when there is nothing to read, so a
   caller can fall back to showing what it has rather than a broken date. */
function localDayOfIso(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : localDayStr(d);
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ======================================================= the engine ===== */

/* "1.4.2" -> [1,4,2]; anything unparseable -> null. */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/* The pre-release part of "2.0.0-lab.1" ("lab.1"), or null for a release. */
function preRelease(v) {
  const m = /^\d+\.\d+\.\d+-([0-9A-Za-z.-]+)/.exec(String(v || '').trim());
  return m ? m[1] : null;
}

/* -1, 0, 1 ; null when either side is not a version. Semver precedence
   (0.7.0): a pre-release sorts BELOW its release, so 2.0.0-lab < 2.0.0, the
   same order the manifest builders sort in. Identifiers compare one dot
   segment at a time, numbers numerically and below words. Build metadata
   ("+abc") is ignored, as semver says. */
function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  const ra = preRelease(a), rb = preRelease(b);
  if (ra === rb) return 0;
  if (ra === null) return 1;
  if (rb === null) return -1;
  const xa = ra.split('.'), xb = rb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]), nb = /^\d+$/.test(xb[i]);
    if (na && nb) {
      if (Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) < Number(xb[i]) ? -1 : 1;
      continue;
    }
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

/* The numeric core only: "2.0.0-lab" and "2.0.0" are the same release line.
   Used where the question is "is this at or after the split", not which of
   two builds is newer. */
function compareCore(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/* ------------------------------------------------- manifest shapes ----- */
/*
 * THE SPLIT (ICOR for Life Scaffold 2.0.0, myPKA 6.0.0). The one scaffold
 * became two products: ICOR for Life (the content vault, `.icor-for-life/`)
 * and myPKA (the AI team, `.mypka/`). Their manifests changed shape while
 * `schema` stayed 1 for a while:
 *
 *   list shape (1.x): files: [{ path, sha256, kind, example }]
 *   map shape (2.0.0-lab on): files: { path: sha256 }, the manifest itself
 *     as "self", no kind and no example flag (an `examples` list instead),
 *     plus `seed`, `previous`, `requires` / `implements`.
 *
 * normalizeManifest reads both into one shape, so nothing below it ever
 * branches on the shape again. It branches on `schema` first (1 or 2 are
 * read; anything else is refused with a sentence) and on the shape of
 * `files` second, because a schema 1 manifest can carry either shape.
 */
const MYPKA_DIR = '.mypka';
const MANIFEST_SCHEMAS = [1, 2];
/* The rooms GL-1013 §6 uses as the content marker. */
const CONTENT_ROOMS = ['00 Daily Scratchpad', '01 Inbox', '03 WiP', '04 Inner World'];
/* The release the split happened in: a removal at or after it may be a move. */
const SPLIT_VERSION = '2.0.0';

/* The builder's own `kind_of` (build-scaffold-manifest.py), ported once so a
   map-shape manifest, which no longer carries a kind, still reads
   "Canonical guideline is missing" and never "Canonical undefined". */
function kindOf(path) {
  const p = String(path || '');
  if (p.endsWith('.base')) return 'base';
  if (p.includes('/Guidelines/')) return 'guideline';
  if (p.includes('/SOPs/')) return 'sop';
  if (p.includes('/Workstreams/')) return 'workstream';
  if (p.includes('/Agents/')) return 'agent';
  if (p.includes('/Scripts/')) return 'script';
  if (p.includes('/Avatars/') || p.includes('/Brand/')) return 'asset';
  if (p.startsWith(CONFIG_DIR + '/')) return 'config';
  if (p.startsWith('.claude/')) return 'claude';
  return 'doc';
}

/* A manifest is untrusted input (Vex, 0.7.0). A path is read only when it is
   vault-relative and cannot climb out: no leading slash or backslash, no
   drive letter, no backslash at all, no `..`, `.` or empty segment. A note
   reaches the report only without markdown that could render or link. */
const safeRel = (p) => typeof p === 'string' && p.length < 512 && !/^[/\\]|^[A-Za-z]:|\\/.test(p) && !p.split('/').some((s) => s === '..' || s === '.' || s === '');
const md = (s) => String(s).replace(/[`![\]<>()]/g, '').slice(0, 200);

const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : []);

/*
 * normalizeManifest(raw) -> {
 *   normalized: true, schema, shape: 'list'|'map', name, version,
 *   files: Map(path -> { path, sha256, kind, example, seed }),
 *   agents: [..] or null, history: [..], historyPresent,
 *   previous: { path: [sha256] } or null, examplesKnown,
 *   rooms, plugins, snippets, bases, implements, requires }
 *
 * `examplesKnown` is false when the manifest says nothing about examples
 * (a map-shape manifest without `examples`): every `example` is then false
 * and nothing more is claimed. Throws only when `files` is neither a list
 * nor an object, or the schema is one this plugin does not read.
 */
function normalizeManifest(raw) {
  if (raw && raw.normalized === true && raw.files instanceof Map) return raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the latest manifest is not a scaffold manifest');
  if (raw.schema !== undefined && !MANIFEST_SCHEMAS.includes(raw.schema)) {
    throw new Error('the manifest carries schema ' + JSON.stringify(raw.schema) + ' and this plugin reads schemas ' + MANIFEST_SCHEMAS.join(' and ') + '; update the plugin');
  }
  const src = raw.files;
  const shape = Array.isArray(src) ? 'list' : (src && typeof src === 'object') ? 'map' : null;
  if (!shape) throw new Error('the latest manifest is not a scaffold manifest');
  const seed = new Set(strings(raw.seed));
  const listed = Array.isArray(raw.examples) ? new Set(strings(raw.examples)) : null;
  const flagged = new Set();
  const files = new Map();
  if (shape === 'list') {
    for (const f of src) {
      if (!f || typeof f !== 'object' || !safeRel(f.path)) continue;
      if (f.example === true) flagged.add(f.path);
      files.set(f.path, { path: f.path, sha256: typeof f.sha256 === 'string' ? f.sha256 : '', kind: typeof f.kind === 'string' && f.kind ? f.kind : kindOf(f.path) });
    }
  } else {
    for (const path of Object.keys(src)) {
      const v = src[path];
      if (v === 'self' || typeof v !== 'string' || !safeRel(path)) continue; /* the manifest's own entry, or an unsafe path */
      files.set(path, { path, sha256: v, kind: kindOf(path) });
    }
  }
  const examples = listed || (shape === 'list' ? flagged : null);
  for (const f of files.values()) {
    f.example = !!(examples && examples.has(f.path));
    f.seed = seed.has(f.path);
  }
  return {
    normalized: true,
    schema: typeof raw.schema === 'number' ? raw.schema : null,
    shape,
    name: typeof raw.name === 'string' ? raw.name : '',
    version: typeof raw.version === 'string' ? raw.version : null,
    files,
    examplesKnown: !!examples,
    agents: Array.isArray(raw.agents) ? raw.agents : null,
    history: Array.isArray(raw.history) ? raw.history : [],
    historyPresent: Array.isArray(raw.history),
    previous: raw.previous && typeof raw.previous === 'object' && !Array.isArray(raw.previous) ? raw.previous : null,
    rooms: strings(raw.rooms),
    plugins: strings(raw.plugins),
    snippets: Array.isArray(raw.snippets) ? raw.snippets : null,
    bases: Array.isArray(raw.bases) ? raw.bases : [],
    implements: typeof raw.implements === 'string' ? raw.implements : null,
    requires: typeof raw.requires === 'string' ? raw.requires : null,
  };
}

/* The same, for a manifest that may be broken: null instead of a throw. A
   vault's own manifest is evidence, never a reason to stop the check. */
function normalizeOrNull(raw) {
  if (!raw) return null;
  try { return normalizeManifest(raw); } catch (e) { return null; }
}

/* ------------------------------------------------ the installed pair ---- */
/* GL-1013 §8.1: myPKA `requires: "icor-concepts >=1 <2"`, ICOR for Life
   `implements: "icor-concepts/1"`. Parsed with exactly these two patterns;
   anything else is "not verified", never a verdict. */
function parseRequires(s) {
  const m = /^icor-concepts >=(\d+) <(\d+)$/.exec(String(s || '').trim());
  return m ? { lo: Number(m[1]), hi: Number(m[2]) } : null;
}
function parseImplements(s) {
  const m = /^icor-concepts\/(\d+)$/.exec(String(s || '').trim());
  return m ? Number(m[1]) : null;
}

/* The GitHub token goes only to GitHub. Before 0.7.0 it went to whatever
   host the URL setting named; with two URLs that risk doubled. */
const TOKEN_HOSTS = ['github.com', 'api.github.com', 'raw.githubusercontent.com'];
function tokenAllowedFor(url) {
  const m = /^https:\/\/([^/?#:]+)(?::\d+)?(?:[/?#]|$)/i.exec(String(url || '').trim());
  return !!m && TOKEN_HOSTS.includes(m[1].toLowerCase());
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
    for (const r of h.removed || []) {
      if (!r || !safeRel(r.path)) continue;
      if (r.moved_to !== undefined && !safeRel(r.moved_to)) continue;
      /* `moved_to` (the builders from schema 2): the file did not go away,
         it moved to the other product. Carried so a caller can say so. */
      out.push({ path: r.path, sha256: r.sha256 || '', note: r.note ? md(r.note) : '', version: h.version, movedTo: typeof r.moved_to === 'string' ? r.moved_to : '' });
    }
    for (const r of h.renamed || []) {
      if (!r || !safeRel(r.from) || !safeRel(r.to)) continue;
      out.push({ path: r.from, sha256: r.from_sha256 || '', note: 'renamed to `' + md(r.to) + '`', version: h.version, to: r.to });
    }
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
/* THE DAILY SCRATCHPAD SHAPE (GL-1004, amended 2026-09-10).
 *
 * Everything in `00 Daily Scratchpad/` sits in `YYYY/MM/` and carries one of
 * three names: the daily note `YYYY-MM-DD.md`, the quick capture
 * `YYYYMMDDHHmm.md` (optionally ` - Title` added after the fact, ` 2` on a
 * same-minute collision), or a toolbar canvas `YYYY-MM-DD_canvas.canvas`.
 * `Untitled` is the subject note before the member names it.
 *
 * Two things create strays without anyone deciding to. Obsidian's new-file
 * location points at this room, so every click on a `[[wikilink]]` with no
 * note behind it drops a title-named file here; and a vault that predates the
 * nesting has its whole history loose at the room root. Both read as tidy in
 * the file tree and are exactly what this check is for.
 */
const SCRATCHPAD_ROOT = '00 Daily Scratchpad';
const SCRATCHPAD_SHAPES = [
  /^\d{4}-\d{2}-\d{2}\.md$/,                       // daily note
  /^\d{12}( \d+)?( - .+)?\.md$/,                    // quick capture, YYYYMMDDHHmm
  /^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.md$/,         // legacy YYYY-MM-DD-HHmmss
  /^\d{14}(-\d+)?\.md$/,                           // legacy YYYYMMDDHHMMSS
  /^Untitled( \d+)?\.md$/,                          // subject note, not yet named
  /^\d{4}-\d{2}-\d{2}_canvas([-_ ].*)?\.canvas$/,  // toolbar canvas
];

/* Returns null when the path is fine, or the reason it is not. A `.base` is a
   saved view of the whole room and belongs at its root, so it is judged on
   placement rather than on its name. */
function scratchpadProblem(path) {
  const rel = path.slice(SCRATCHPAD_ROOT.length + 1);
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  if (name.startsWith('.') || name === 'README.md' || name === 'INDEX.md' || name === '_template.md') return null;
  if (name.endsWith('.base')) {
    return parts.length === 1 ? null : 'nesting-base';
  }
  if (parts.length !== 3 || !/^\d{4}$/.test(parts[0]) || !/^\d{2}$/.test(parts[1])) return 'nesting';
  return SCRATCHPAD_SHAPES.some((re) => re.test(name)) ? null : 'name';
}

/* ------------------------------------------ the generated harness layer --- */
/*
 * Scaffold 1.23.0 stopped shipping its host bindings typed by hand and
 * started generating them: `Scripts/scaffold-init.py apply` writes the
 * skills, the Codex and Gemini agent shims, the hook configs and the host
 * pointers from the vault's OWN frontmatter. Two vaults on the same
 * scaffold version therefore hold different bytes in these files on
 * purpose, and the three-way file check below would call every one of them
 * "you edited this file" on any vault that has hired one agent.
 *
 * What makes a file generated here is the header it carries, never a path
 * list: the generator can change which files it owns without this plugin
 * learning about it, and a file that stops being generated stops carrying
 * the marker. The header names the source and carries a twelve-character
 * content hash over the rest of the file.
 *
 * Recomputing that hash is the same arithmetic `scaffold-init.py check`
 * does, and it answers the only question worth asking about one of these
 * files. Intact: the bytes differ from the scaffold's copy because your
 * sources differ, and there is nothing to do. Mismatch: somebody edited it
 * by hand, and the next apply overwrites the edit without saying so.
 *
 * JSON is its own case, because JSON cannot carry a comment. The header
 * lives in the `description` VALUE and the hash covers the re-serialised
 * `hooks` key alone. Dropping the line that carries the marker would leave
 * the file unparseable and hash something that never existed.
 */
const GEN_MARK = 'GENERATED by scaffold-init.py';
const GEN_HASH_RE = /content-hash:([0-9a-f]{12})/;
const GEN_SOURCE_RE = /from `([^`]+)`/;
const GEN_SCRIPT = '06 AI Team/AI Team Knowledge/Scripts/scaffold-init.py';
const GEN_FIX = 'Run `python3 "' + GEN_SCRIPT + '" apply` from the vault root. A generated file is never fixed by hand and never copied in from the scaffold: change the source it names, then re-run the generator.';
/* A link has no source to edit, so it gets its own line: telling someone to
   change the source of a symlink is an instruction nobody can follow. */
const LINK_FIX = 'Run `python3 "' + GEN_SCRIPT + '" apply` from the vault root. It writes these links from the skills in your vault; they are per device, so this is normal after a sync to a new machine.';

/* The paths the generator owns, used ONLY to word the fix for a file that
   is MISSING, because an absent file carries no header to read. A file
   that is present is judged by its header and never by this list.

   `.claude/agents/*.md` is deliberately not here. The generator classifies
   those shims as held by hand, since they carry body lines the contract
   does not, so "copy it in from the latest scaffold" is still the right
   fix for them and treating them as generated would be a lie the member
   would act on. */
const HARNESS_PATHS = [
  /^06 AI Team\/AI Team Knowledge\/Skills\/[^/]+\/SKILL\.md$/,
  /^\.claude\/skills\/[^/]+\/SKILL\.md$/,
  /^\.claude\/settings\.README\.md$/,
  /^\.claude\/settings\.json$/,
  /^\.codex\/agents\/[^/]+\.toml$/,
  /^\.codex\/(hooks\.json|config\.toml)$/,
  /^\.gemini\/agents\/[^/]+\.md$/,
  /* `GEMINI.md` left this list in 0.7.0: the split removed it (b8y), so a
     missing one is not a generated file to regenerate. */
];
function isHarnessPath(p) { return HARNESS_PATHS.some((re) => re.test(String(p))); }

/* The one file the generator owns only PART of: it writes the `hooks` key
   of `.claude/settings.json` and leaves every other key alone, so the file
   carries no header and its bytes differing from the scaffold's copy is
   the normal case rather than an edit to report. */
function isPartlyGenerated(p) { return String(p) === '.claude/settings.json'; }

/* GL-1008's membership test, as a guard. A file under `.icor-for-life/` is
   there because something regenerates it, so it is state and never drift:
   the per-session receipts and `session.json` that `checkpoint.py` writes,
   the harness and quality numbers, and this plugin's own run history. None
   of them belongs in a manifest; if one ever appears in one, that is an
   upstream defect, and reporting it at a member's vault would be this
   plugin repeating it. */
const MACHINE_STATE = [
  /^\.icor-for-life\/scripts\/receipts\//,
  /^\.icor-for-life\/scripts\/session\.json$/,
  /^\.icor-for-life\/scripts\/harness\.json$/,
  /^\.icor-for-life\/scripts\/quality\.json$/,
  /^\.icor-for-life\/icor-for-life-[^/]+\//,
  /* myPKA's machine layer (0.7.0): the team's regenerated state, the
     member's own sources file, and installed expansions. */
  /^\.mypka\/state\//,
  /^\.mypka\/sources\.yaml$/,
  /^\.mypka\/expansions\//,
];
function isMachineState(p) { return MACHINE_STATE.some((re) => re.test(String(p))); }

/* The version folders' own descriptors. Since the split they are hashed
   into `files`, so every older install would read "changed upstream" for
   them; the version gap already says that, once. The concept schema and
   the two `sources*.example` files are NOT here: a changed example matters
   (Vex residual 2). */
const DESCRIPTORS = /^\.(icor-for-life|mypka)\/(VERSION|CHANGELOG\.md|README\.md|manifest\.json)$/;
function isDescriptor(p) { return DESCRIPTORS.test(String(p)); }

/* The first line that is a generated header, or null.
   A header is the marker AND a `content-hash:` on the SAME line, never the
   marker alone. The generator's own source carries the marker as a string
   constant, and so does its test suite; matching on the marker alone
   reported both of them as generated files that had lost their hash, which
   is a finding a member cannot act on and cannot silence.
   And only where the generator writes it: the first line that is not blank,
   after the frontmatter when there is one. A test suite that builds a header
   from a format string carries both on one line, deep in its body, and was
   reported as a generated file that had lost its hash. */
function generatedHeaderLine(text) {
  const lines = String(text).split('\n');
  let i = 0;
  if (lines[0] === '---') { const end = lines.indexOf('---', 1); if (end > 0) i = end + 1; }
  while (i < lines.length && lines[i].trim() === '') i++;
  const line = lines[i];
  return line !== undefined && line.includes(GEN_MARK) && line.includes('content-hash:') ? line : null;
}

/* { header, body } for a generated file, or { header: null } for one this
   plugin must not touch. `body` is exactly the bytes the header's hash
   covers. */
function generatedDigestInput(path, text) {
  /* Line endings are normalised before anything is hashed, because the
     generator hashes LF text on every platform and cannot avoid it. Python's
     `write_text` with the default newline translates every `\n` to
     `os.linesep`, so on Windows these files sit on disk as CRLF; `read_text`
     translates them back under universal newlines, so `scaffold-init.py
     check` hashes LF and says intact. Reading the raw bytes here would hash
     CRLF, call every generated file hand-edited, and print a fix that
     rewrites the same bytes, so the finding could never clear. This is
     exactly Python's read-side rule: CRLF and a lone CR both become LF. */
  const s = String(text).replace(/\r\n?/g, '\n');
  if (String(path).endsWith('.json')) {
    let doc;
    try { doc = JSON.parse(s); } catch { return { header: null }; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { header: null };
    const desc = typeof doc.description === 'string' ? doc.description : '';
    if (!desc.includes(GEN_MARK) || !desc.includes('content-hash:')) return { header: null };
    return { header: desc, body: JSON.stringify({ hooks: 'hooks' in doc ? doc.hooks : {} }, null, 2) };
  }
  const line = generatedHeaderLine(s);
  if (line === null) return { header: null };
  /* The generator strips every line carrying the marker, so this strips on
     the same rule or the two hash different text and every file reports as
     hand-edited. */
  return { header: line, body: s.split('\n').filter((l) => !l.includes(GEN_MARK)).join('\n') };
}

/*
 * generatedState(path, text, hash) -> { state, source } or null when the
 * file is not generated.
 *
 * state: 'intact' (still the bytes the generator would write), 'edited'
 * (the header is there and the body no longer matches it), 'unhashed' (a
 * header from a generator older than the content hash), 'unreadable' (the
 * hash could not be taken here, so nothing is claimed either way).
 * `hash` is the engine's sha256-over-bytes; the generator keeps its first
 * twelve hex characters.
 */
async function generatedState(path, text, hash) {
  const d = generatedDigestInput(path, text);
  if (d.header === null) return null;
  const source = (GEN_SOURCE_RE.exec(d.header) || [])[1] || null;
  const m = GEN_HASH_RE.exec(d.header);
  if (!m) return { state: 'unhashed', source };
  let have = null;
  try { have = await hash(new TextEncoder().encode(d.body)); } catch { have = null; }
  if (have === null) return { state: 'unreadable', source };
  return { state: String(have).slice(0, 12) === m[1] ? 'intact' : 'edited', source };
}

/* Where the host link layer and the canonical skills live. */
const HOST_LINKS_DIR = '.agents/skills';
const SKILLS_DIR = '06 AI Team/AI Team Knowledge/Skills';

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
async function checkAgents({ fs, remote, add, metaDir, product }) {
  const from = product || 'scaffold';
  const skipMissing = new Set();
  const contracts = await readContracts(fs);
  const claimed = new Set(); /* paths rule 1 already reported; rule 2 stays quiet on them */

  const shipped = Array.isArray(remote.agents) ? remote.agents : null;
  if (!shipped) {
    add('agents', 'info', (metaDir || META_DIR) + '/manifest.json',
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
            'If this is your own agent, give it its own folder, then copy the shipped ' + a.name + ' in from the latest ' + from + '. Never change the id on either file to make them match.');
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
 * runChecks({ fs, hash, remote, local, installedVersion, configDir, ...opts })
 *
 *   fs.exists(path) -> bool, fs.read(path) -> string, fs.readBinary(path)
 *   -> ArrayBuffer|Buffer, fs.listBases() -> [paths of every .base outside
 *   .obsidian], fs.listAgentContracts() -> [every 06 AI Team/Agents/<Name>/
 *   AGENT.md], fs.listShims() -> [every .claude/agents/<slug>.md]  (all async)
 *   hash(bytes) -> hex sha256 (async)
 *   remote: the latest manifest, either shape (normalizeManifest). local:
 *   the vault's own manifest, either shape, or null. installedVersion: the
 *   VERSION file's content or null. configDir: the vault's config folder
 *   (`app.vault.configDir`), default `.obsidian`; a device on a
 *   config-folder profile keeps its plugins elsewhere.
 *
 * ONE product per call (0.7.0). The options say which, and the defaults are
 * the single-scaffold check every version before 0.7.0 ran:
 *   repo ('icor' | 'mypka'), metaDir (the version folder), product (the
 *   words a fix names: "Copy it in from the latest <product>"),
 *   agents / structure / hostLinks (which blocks run: myPKA owns the agent
 *   identities and the host links, ICOR for Life the rooms, Bases,
 *   plugins, snippets and the Scratchpad),
 *   syncFold (fold dot-folder paths a Sync device cannot have into one
 *   line), otherRemote (the OTHER product's latest manifest: a removal it
 *   ships is a move, never a leftover; null means "could not be read", and
 *   undefined means "there is no other product", the pre-0.7.0 case),
 *   splitVersion (with otherRemote null: removals at or after it are not
 *   judged), quietMissingVersion (the caller has already said why there is
 *   no version, as in a vault installed before the split).
 *
 * Returns { repo, health, installedVersion, latestVersion, findings, counts }.
 * A finding: { kind, severity, path, message, action, repo, since? }.
 * severity: 'broken' (structure the vault relies on is gone), 'attention'
 * (something to do), 'info' (worth knowing, nothing to do).
 */
async function runChecks(args) {
  const { fs, hash, configDir } = args;
  const cfg = (configDir || CONFIG_DIR).replace(/\/+$/, '');
  const repo = args.repo || 'icor';
  const metaDir = args.metaDir || META_DIR;
  const product = args.product || 'scaffold';
  const findings = [];
  const add = (kind, severity, path, message, action, extra) =>
    findings.push(Object.assign({ kind, severity, path, message, action, repo }, extra || {}));

  if (!args.remote || typeof args.remote !== 'object' || !('files' in args.remote)) {
    throw new Error('the latest manifest is not a scaffold manifest');
  }
  const remote = normalizeManifest(args.remote);
  const local = normalizeOrNull(args.local);
  const latest = remote.version || null;
  /* `localVersion: false`: the local manifest is borrowed evidence of which
     bytes were installed (a pre-split vault's ICOR manifest, read for the
     team files), never the version of THIS product. */
  const installed = args.installedVersion || (args.localVersion !== false && args.local && typeof args.local.version === 'string' ? args.local.version : null) || null;

  /* Obsidian Sync never carries a dot folder (only the config folder), so on
     a device that got the vault through Sync, `.mypka/`, `.claude/` and the
     rest are simply not there. That is not damage, and fifty "missing"
     lines would bury the one line that says why (GL-1013: warn, never
     refuse). A dot path whose TOP folder or file is absent is counted into
     one line; a dot folder that exists with a file missing inside it is
     still reported file by file. */
  const syncFold = args.syncFold === true;
  /* A vault that predates this product's version folder: its files are not
     "missing", the caller has already said to install the folder. */
  const metaNotInstalled = args.metaNotInstalled === true;
  const cfgTop = cfg.split('/')[0];
  const topAbsent = new Map();
  const folded = { count: 0, tops: new Set() };
  async function absentDotTop(p) {
    if (!syncFold) return null;
    const top = String(p).split('/')[0];
    if (!top.startsWith('.') || top === cfgTop) return null;
    if (!topAbsent.has(top)) {
      let there = false;
      try { there = !!(await fs.exists(top)); } catch (e) { there = false; }
      topAbsent.set(top, !there);
    }
    return topAbsent.get(top) ? top : null;
  }
  const metaAbsent = syncFold && !!(await absentDotTop(metaDir));

  /* 1. the version gap */
  if (!installed) {
    if (metaAbsent) {
      folded.tops.add(metaDir); /* said once, in the Sync line below */
    } else if (!args.quietMissingVersion) {
      add('version', 'info', metaDir + '/VERSION',
        'This vault does not carry a ' + product + ' version, so every removal in the ' + product + '\'s history is treated as possibly still here.',
        'Add `' + metaDir + '/VERSION` with the version you installed, or update to the latest ' + product + ' and take its version folder.');
    }
  } else if (compareVersions(installed, latest) < 0) {
    add('version', 'attention', metaDir + '/VERSION',
      'Installed ' + installed + ', latest ' + latest + '.',
      'Read the changelog for every version after ' + installed + ' before updating; the leftover findings below are the parts that need a hand.');
  } else if (compareVersions(installed, latest) > 0) {
    add('version', 'info', metaDir + '/VERSION',
      'Installed ' + installed + ' is newer than the latest published ' + latest + '.',
      'Nothing to do; you are ahead of the manifest this check fetched.');
  }

  /* 2. rooms: the folders the scaffold relies on */
  if (args.structure !== false) {
    for (const room of remote.rooms) {
      if (!(await fs.exists(room))) {
        add('room', 'broken', room, 'Required folder is missing.', 'Create it. The scaffold and its plugins write here and will fail without it.');
      }
    }
  }

  /* 3. agent identities (before the files, because a shipped agent found by
     its id under another name must not be reported missing below) */
  const foundElsewhere = args.agents === false ? new Set() : await checkAgents({ fs, remote, add, metaDir, product });

  /* 4. canonical files: three-way */
  const localHashes = new Map();
  if (local) for (const f of local.files.values()) localHashes.set(f.path, f.sha256);
  for (const f of remote.files.values()) {
    const fk = { fileKind: f.kind };
    if (isMachineState(f.path)) continue; /* state, never drift (GL-1008) */
    if (isDescriptor(f.path)) continue; /* the version gap already says it */
    if (metaNotInstalled && f.path.startsWith(metaDir + '/')) continue;
    const dotTop = await absentDotTop(f.path);
    if (dotTop) { folded.count++; folded.tops.add(dotTop); continue; }
    const exists = await fs.exists(f.path);
    if (!exists) {
      if (f.example) continue; /* example notes are meant to be deleted */
      if (foundElsewhere.has(f.path)) continue; /* the agent lives under the member's own name */
      if (f.seed) {
        add('file', 'attention', f.path, 'Canonical ' + f.kind + ' is missing. It is a starting file: it becomes yours after the first install.',
          'Add it: copy it in from the latest ' + product + ' once. After that it is yours to change, and this check never compares it again.', fk);
        continue;
      }
      if (isHarnessPath(f.path)) {
        add('generated', 'attention', f.path, 'Generated harness file is missing, so the host that reads it reads nothing.', GEN_FIX, fk);
        continue;
      }
      add('file', 'attention', f.path, 'Canonical ' + f.kind + ' is missing.', 'Copy it in from the latest ' + product + '.', fk);
      continue;
    }
    /* The updater (`mypka-update.py`) never overwrites an edited file: it
       writes the new version beside it as `<file>.update`. One left there is
       a merge nobody has done yet. */
    let pending = false;
    try { pending = !!(await fs.exists(f.path + '.update')); } catch (e) { pending = false; }
    if (pending) {
      add('update', 'attention', f.path + '.update',
        'An update is waiting for your merge: the updater left the new version of `' + f.path + '` beside your edited copy.',
        'Compare the two, keep what you want in `' + f.path + '`, then delete the `.update` file. Nothing reads it.', fk);
    }
    /* A seed ships once and is the member's from then on (`.obsidian/
       workspace.json`, `.mcp.json`): it differs on every vault by design. */
    if (f.seed) continue;
    let have;
    try { have = await hash(await fs.readBinary(f.path)); } catch (e) { have = null; }
    if (have === f.sha256) continue;

    /* Generated from this vault's own frontmatter, so bytes that differ
       from the scaffold's copy are the normal case. Only the hash in the
       file's own header can say whether a hand touched it. */
    let text = null;
    try { text = await fs.read(f.path); } catch { text = null; }
    const gen = text === null ? null : await generatedState(f.path, text, hash);
    if (gen) {
      const from = gen.source ? '`' + gen.source + '`' : 'its source';
      if (gen.state === 'intact') {
        add('generated', 'info', f.path, 'Generated from ' + from + ', and its body still matches the hash in its own header, so it differs from the scaffold only because your source does.',
          'Nothing to do. This file is rewritten from your vault by `scaffold-init.py apply`; it is not a scaffold file you keep in step.',
          Object.assign({ collapse: 'generated-intact' }, fk));
      } else if (gen.state === 'edited') {
        add('generated', 'attention', f.path, 'Generated from ' + from + ', and its body no longer matches the hash in its own header, so it was edited by hand.',
          'Move what you added into ' + from + '. ' + GEN_FIX + ' The next apply overwrites this file and the edit goes with it.', fk);
      } else if (gen.state === 'unhashed') {
        add('generated', 'attention', f.path, 'Carries the generated header but no content hash, so it was written by a generator older than this check and cannot be verified.', GEN_FIX, fk);
      } else {
        add('generated', 'info', f.path, 'Generated from ' + from + '. Not checked: its hash could not be taken on this platform.',
          'Nothing to do here. Run `python3 "' + GEN_SCRIPT + '" check` in the ICOR for Life Terminal for the answer.', fk);
      }
      continue;
    }
    if (isPartlyGenerated(f.path)) {
      add('generated', 'info', f.path, 'The generator owns the `hooks` key of this file and leaves every other key to you, so it differing from the scaffold\'s copy is expected.',
        'Run `python3 "' + GEN_SCRIPT + '" check` to see whether the generated part is current. Never copy this file in from the scaffold: that would drop your own settings.', fk);
      continue;
    }
    const installedHash = localHashes.get(f.path);
    const older = remote.previous && Array.isArray(remote.previous[f.path]) ? remote.previous[f.path] : [];
    if (installedHash && have === installedHash) {
      add('file', 'attention', f.path, 'Changed upstream since you installed; your copy is the version you started with.',
        'Update it from the latest ' + product + '. Safe: you never edited it.', fk);
    } else if (installedHash && installedHash !== f.sha256) {
      add('file', 'info', f.path, 'You edited this file, and it also changed upstream.',
        'Keep yours. Compare against the latest ' + product + ' by hand if you want the upstream change too. This check never overwrites an edited file.', fk);
    } else if (installedHash) {
      add('file', 'info', f.path, 'You edited this file.', 'Keep it. It is yours now.', fk);
    } else if (remote.previous) {
      /* No installed manifest, but the release lists every older byte-state
         of each path: the same evidence `mypka-update.py` uses, so the two
         give the same answer about the same file. */
      if (have !== null && older.includes(have)) {
        add('file', 'attention', f.path, 'An older shipped version: you never edited it.',
          'Update it from the latest ' + product + '. Safe: your copy is bytes a release shipped.', fk);
      } else {
        add('file', 'info', f.path, 'You edited this file.', 'Keep it. It is yours now.', fk);
      }
    } else {
      add('file', 'info', f.path, 'Differs from the latest ' + product + ', and without your installed manifest the check cannot tell whether you changed it or the ' + product + ' did.',
        'Compare by hand, or add `' + metaDir + '/manifest.json` from the version you installed so the next check can tell.', fk);
    }
  }

  /* The Sync line: one per product, never one per file. */
  if (folded.count || folded.tops.size) {
    const tops = [...folded.tops].map((t) => '`' + t + '`').join(', ');
    add('sync', 'info', metaDir,
      (folded.count ? folded.count + ' shipped file' + (folded.count === 1 ? '' : 's') + ' live' + (folded.count === 1 ? 's' : '') + ' in dot folders this device does not have (' + tops + ')' : 'The version folder `' + metaDir + '/` is not on this device')
        + (metaAbsent && folded.count ? ', the version folder `' + metaDir + '/` among them' : '')
        + '. Obsidian Sync does not carry dot folders, so these checks run unverified here.',
      'Run the check on the device you installed on. Nothing is missing because of this.');
  }

  /* 5. leftovers: removed or moved upstream after your version, still here.
     Matched by CONTENT when the manifest knows the old file's hash: a file
     that shares the old name but not the old bytes is the user's own, and
     is reported as a name collision, never as a leftover.

     THE SPLIT (0.7.0). At 2.0.0 the ICOR for Life builder writes every team
     file it no longer ships into its history as removed, with the old
     hashes. A member's untouched team files match those hashes exactly, so
     without this partition the check would tell them to delete AGENTS.md
     and every agent. A path the OTHER product ships is a MOVE: no finding
     here, the other product's section judges it. Only a path in neither
     manifest is a leftover. If the other manifest could not be read, a
     removal at or after the split is not judged at all unless its own
     entry says where it went, and one line says why. */
  const moved = new Set();
  const other = args.otherRemote ? normalizeOrNull(args.otherRemote) : null;
  if (other) {
    for (const p of other.files.keys()) moved.add(p);
    for (const a of other.agents || []) {
      if (a && typeof a.path === 'string') moved.add(a.path);
      if (a && typeof a.shim === 'string') moved.add(a.shim);
    }
  }
  const otherUnknown = args.otherRemote === null || (args.otherRemote !== undefined && !other);
  const splitAt = args.splitVersion || null;
  const unjudged = [];
  if (repo === 'mypka' && !remote.historyPresent) {
    add('leftover', 'info', metaDir + '/manifest.json',
      'Leftover check: not available for myPKA ' + (latest || '') + '. Its manifest carries no history yet, so a file myPKA removes later cannot be recognised here.',
      'Nothing to do. A later myPKA manifest carries its history, and this check then names any file it removed.');
  }
  for (const r of removalsSince(remote, installed)) {
    if (isMachineState(r.path)) continue; /* state, never a leftover (GL-1008) */
    if (remote.files.has(r.path)) continue; /* shipped again: the file check judges it */
    if (r.movedTo) continue; /* the entry itself says it moved */
    if (moved.has(r.path)) continue; /* the other product ships it: a move */
    if (otherUnknown && splitAt && compareCore(r.version, splitAt) >= 0) {
      if (await fs.exists(r.path)) unjudged.push(r.path);
      continue;
    }
    if (!(await fs.exists(r.path))) continue;
    let same = true;
    if (r.sha256) {
      let have = null;
      try { have = await hash(await fs.readBinary(r.path)); } catch (e) { have = null; }
      same = have === r.sha256;
    }
    if (same) {
      add('leftover', 'attention', r.path,
        'Removed from the ' + product + ' in ' + r.version + (r.note ? ': ' + (r.to ? r.note : md(r.note)) : '.'),
        'Delete it after reading the ' + r.version + ' changelog entry. Nothing in the ' + product + ' reads it any more.', { since: r.version });
    } else {
      add('collision', 'info', r.path,
        'Shares its name with a ' + product + ' file that was ' + (r.to ? 'renamed to `' + md(r.to) + '`' : 'removed') + ' in ' + r.version + ', but not its content, so it is yours.',
        'Keep it. Nothing to do' + (r.to ? '; the ' + product + '\'s own document now lives at `' + md(r.to) + '`.' : '.'), { since: r.version });
    }
  }
  if (unjudged.length) {
    add('leftover', 'info', metaDir + '/manifest.json',
      unjudged.length + ' file' + (unjudged.length === 1 ? '' : 's') + ' the ' + product + ' stopped shipping in ' + splitAt + ' or later ' + (unjudged.length === 1 ? 'is' : 'are') + ' still here and ' + (unjudged.length === 1 ? 'was' : 'were') + ' not judged. At ' + splitAt + ' the AI team moved to myPKA, and without the myPKA manifest this check cannot tell a file that moved from one that was removed.',
      'Delete nothing on this evidence. Set the latest myPKA manifest URL in the settings, and the next check judges each one: moved files in the myPKA section, the rest as leftovers.');
  }

  if (args.structure !== false) {
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
    if (!Array.isArray(enabled)) enabled = [];
    for (const id of remote.plugins) {
      const there = await fs.exists(cfg + '/plugins/' + id + '/manifest.json');
      if (!there) add('plugin', 'attention', cfg + '/plugins/' + id, 'Plugin is not installed.', 'Install it from the latest scaffold or the community list; the vault is built to have it.');
      else if (!enabled.includes(id)) add('plugin', 'attention', cfg + '/plugins/' + id, 'Plugin is installed but not enabled.', 'Enable it under Settings, Community plugins.');
    }

    /* 8. snippets enabled but gone (the reverse of a leftover) */
    let appearance = {};
    try { appearance = JSON.parse(await fs.read(cfg + '/appearance.json')); } catch (e) { appearance = {}; }
    const enabledSnippets = appearance && Array.isArray(appearance.enabledCssSnippets) ? appearance.enabledCssSnippets : [];
    for (const s of enabledSnippets) {
      if (!(await fs.exists(cfg + '/snippets/' + s + '.css'))) {
        add('snippet', 'attention', cfg + '/snippets/' + s + '.css', 'Enabled in appearance.json but the file is gone.',
          'Disable it under Settings, Appearance, CSS snippets. The scaffold no longer ships it.');
      }
    }
    if (Array.isArray(remote.snippets) && remote.snippets.length === 0 && enabledSnippets.length) {
      add('snippet', 'info', cfg + '/appearance.json', 'The latest scaffold enables no CSS snippets; this vault enables ' + enabledSnippets.length + '.',
        'If they are the scaffold\'s old snippets, disable them; their rules live in the theme now.');
    }

    /* 9. the Daily Scratchpad keeps its shape: YYYY/MM/ nesting and one of the
       three legal names (GL-1004). Reported once per file, because the fix is
       per file and a single "the room is untidy" line tells you nothing about
       which one to move. */
    for (const path of await fs.listScratchpads()) {
      const problem = scratchpadProblem(path);
      if (!problem) continue;
      if (problem === 'nesting-base') {
        add('scratchpad', 'attention', path, 'A saved view belongs at the root of `' + SCRATCHPAD_ROOT + '`, not inside a dated folder.',
          'Move it to `' + SCRATCHPAD_ROOT + '/`. It is a view of the whole room, not of one month.');
      } else if (problem === 'nesting') {
        add('scratchpad', 'attention', path, 'Sits outside `YYYY/MM/`. The Daily Scratchpad is date-nested like the Journal (GL-1004).',
          'Move it into `' + SCRATCHPAD_ROOT + '/<year>/<month>/` for its own date. Check that Settings, Daily notes uses `YYYY/MM/YYYY-MM-DD` and that the Scratchpad plugin uses `YYYY/MM`, or the next note lands loose again.');
      } else {
        add('scratchpad', 'attention', path, 'Is named for its subject rather than its date, so it is a note that has ended up in the capture room.',
          'A note with a subject belongs in `04 Inner World/Notes/`; a person, company or life entity belongs in `04 Inner World/`. Obsidian creates these by clicking a `[[wikilink]]` that has no note behind it, so also check Settings, Files and links, Default location for new notes.');
      }
    }
  }

  /* 10. `.agents/skills/`: the links Codex, Gemini CLI and Cursor read.
     `scaffold-init.py apply` writes them, git never tracks them and the
     download never ships them, so the folder is per device by design.
     ABSENT is therefore not a finding: it means this device has not run
     the generator, which is a choice and not damage. A link that does not
     resolve IS a finding, because the host follows it, finds nothing, and
     says nothing about it.

     The test is whether `<link>/SKILL.md` is there, not anything about
     symlinks. The vault adapter has no `lstat` on any platform, so a
     dangling link is invisible as a link; and what the host actually needs
     is the skill behind the link rather than the link. Where the adapter
     cannot list the folder at all the check says so and claims nothing:
     a platform that cannot look is not a vault that is broken. */
  if (args.hostLinks !== false) {
    const skillNames = typeof fs.listSkillNames === 'function' ? await fs.listSkillNames() : [];
    const links = typeof fs.hostSkillLinks === 'function'
      ? await fs.hostSkillLinks(skillNames)
      : { supported: false, present: false, entries: [] };
    if (!links.supported) {
      add('harness-link', 'info', HOST_LINKS_DIR,
        'Not checked on this device: Codex, Gemini CLI and Cursor do not run here.',
        'Nothing to do. These links exist for the hosts that read them, and none of them runs on a phone or tablet.');
    } else if (links.present) {
      /* The listing failing is itself the finding, not a reason to stay quiet.
         On desktop the adapter stats every entry it lists and a link with no
         target ends the whole call, so the one input this check exists to
         catch is the input that makes the listing fail. Reporting that as
         "could not look" would be a guard whose green is reachable without
         the thing being true. */
      if (links.listable === false) {
        add('harness-link', 'attention', HOST_LINKS_DIR,
          'The folder is here and could not be listed. On a desktop vault that means at least one link in it points at nothing: listing stats every entry, and an entry with no target ends the listing.',
          LINK_FIX);
      }
      for (const e of links.entries || []) {
        if (e.resolves) continue;
        if (e.known) {
          add('harness-link', 'attention', HOST_LINKS_DIR + '/' + e.name,
            'Skill `' + e.name + '` cannot be reached through `' + HOST_LINKS_DIR + '`, so only Claude Code can see it. Either there is no link, or the link points at nothing.',
            LINK_FIX);
        } else {
          add('harness-link', 'attention', HOST_LINKS_DIR + '/' + e.name,
            'Points into `' + SKILLS_DIR + '` at something that is not there, so Codex, Gemini CLI and Cursor read nothing for it and report no error.',
            LINK_FIX);
        }
      }
    }
  }

  const counts = countFindings(findings);
  const health = counts.broken ? 'broken' : counts.attention ? 'attention' : 'ok';
  return { repo, health, installedVersion: installed, latestVersion: latest, findings, counts };
}

function countFindings(findings) {
  const counts = { broken: 0, attention: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

/* ------------------------------------------------------ the suite (0.7.0) - */
/*
 * Which half of the split is in this vault. The markers are GL-1013 §6's,
 * never a third rule:
 *   team      `AGENTS.md` and `06 AI Team/Agents/` (neither is a dot path,
 *             so both survive Obsidian Sync)
 *   icor      `.icor-for-life/manifest.json`, or the four content rooms
 *   mypkaDir  `.mypka/manifest.json`
 *   preSplit  team and icor, no `.mypka/`, and an ICOR version below 2.0.0
 *
 * Mode B (team in its own folder) and "no team at all" look the same from a
 * content vault, and this check does not pretend it can tell them apart:
 * `sources.yaml` lives in the team root, not here.
 */
async function detectMode(fs, icorInstalled) {
  const ex = async (p) => { try { return !!(await fs.exists(p)); } catch (e) { return false; } };
  const team = (await ex('AGENTS.md')) && (await ex(AGENTS_DIR));
  let rooms = true;
  for (const r of CONTENT_ROOMS) if (!(await ex(r))) { rooms = false; break; }
  const icor = (await ex(META_DIR + '/manifest.json')) || rooms;
  const mypkaDir = await ex(MYPKA_DIR + '/manifest.json');
  const preSplit = team && icor && !mypkaDir && compareVersions(icorInstalled, SPLIT_VERSION) === -1;
  const name = team ? (icor ? 'A' : 'B-team') : (icor ? 'B-content' : 'none');
  return { name, team, icor, mypkaDir, preSplit };
}

const MODE_TEXT = {
  A: 'content and team in one vault (mode A)',
  'B-team': 'myPKA team folder opened as a vault (mode B, team side)',
  'B-content': 'content vault (mode B, or no team)',
  none: 'not an ICOR for Life or myPKA vault',
};

/* A version folder's two files, through the engine's fs: { version,
   manifest } with null for anything absent or unreadable. Never throws. */
async function readLocalPair(fs, dir) {
  let version = null, manifest = null;
  try { if (await fs.exists(dir + '/VERSION')) version = String(await fs.read(dir + '/VERSION')).trim() || null; } catch (e) { version = null; }
  try { if (await fs.exists(dir + '/manifest.json')) manifest = JSON.parse(await fs.read(dir + '/manifest.json')); } catch (e) { manifest = null; }
  return { version, manifest };
}
async function readLocalPairs(fs) {
  return { icor: await readLocalPair(fs, META_DIR), mypka: await readLocalPair(fs, MYPKA_DIR) };
}

/* The team's words for "the team is not here", used in the report, the
   dashboard and the harness block alike. */
const TEAM_ELSEWHERE = 'The myPKA team is not in this vault. In mode B it lives in its own folder and is checked there. Nothing is missing here.';
const CONTENT_ELSEWHERE = 'ICOR for Life is not in this folder: this is the myPKA team opened as a vault. The content lives elsewhere and is checked there.';

/* ok < offline < attention < broken: a product that could not be fetched
   is worse than a clean one and never better than something to do. */
const HEALTH_RANK = { ok: 0, offline: 1, attention: 2, broken: 3 };

/*
 * runSuite({ fs, hash, configDir, local?, icorRemote, icorError,
 *            mypkaRemote, mypkaError, mypkaUrlSet })
 *
 * Both products in one pass (0.7.0). Remotes are the parsed latest
 * manifests, either shape; an error is the sentence for why one could not
 * be fetched. `mypkaUrlSet` false means nobody has told this plugin where
 * myPKA is published, which is "not checked", never "offline": the plugin
 * never guesses a URL. `local` is readLocalPairs(fs), read here when absent.
 *
 * Returns { suite: true, mode, sections: { icor, mypka }, findings, counts,
 * health, installedVersion, latestVersion, mypkaInstalledVersion,
 * mypkaLatestVersion }. Every finding carries `repo`: 'icor', 'mypka', or
 * 'pair' for what is about the two together. A section: { status, title,
 * installedVersion, latestVersion } where status is a health, 'offline',
 * 'not-checked' or 'elsewhere'.
 */
async function runSuite(args) {
  const { fs, hash, configDir } = args;
  const local = args.local || await readLocalPairs(fs);
  const icorLocal = normalizeOrNull(local.icor.manifest);
  const mypkaLocal = normalizeOrNull(local.mypka.manifest);
  const icorInstalled = local.icor.version || (icorLocal && icorLocal.version) || null;
  const mypkaInstalled = local.mypka.version || (mypkaLocal && mypkaLocal.version) || null;
  const mode = await detectMode(fs, icorInstalled);

  let icorRemote = null, icorError = args.icorError || '';
  let mypkaRemote = null, mypkaError = args.mypkaError || '';
  if (args.icorRemote && !icorError) { try { icorRemote = normalizeManifest(args.icorRemote); } catch (e) { icorError = e.message; } }
  if (args.mypkaRemote && !mypkaError) { try { mypkaRemote = normalizeManifest(args.mypkaRemote); } catch (e) { mypkaError = e.message; } }
  const mypkaUrlSet = args.mypkaUrlSet !== false;

  const findings = [];
  const note = (repo, kind, path, message, action) => findings.push({ kind, severity: 'info', path, message, action, repo });
  const sections = {
    icor: { status: 'not-checked', title: 'ICOR for Life (content)', installedVersion: icorInstalled, latestVersion: icorRemote ? icorRemote.version : null },
    mypka: { status: 'not-checked', title: 'myPKA (team)', installedVersion: mypkaInstalled, latestVersion: mypkaRemote ? mypkaRemote.version : null },
  };

  if (mode.name === 'none') {
    note('pair', 'mode', '/', 'This folder carries neither ICOR for Life (no `.icor-for-life/` and not the four content rooms) nor the myPKA team (no `AGENTS.md` with `06 AI Team/Agents/`).',
      'Nothing to check here. Open the vault you installed ICOR for Life or myPKA into.');
  } else {
    /* ---- ICOR for Life ---- */
    if (!mode.icor) {
      sections.icor.status = 'elsewhere';
      note('icor', 'mode', META_DIR, CONTENT_ELSEWHERE, 'Nothing to do here. Run the check in your content vault to see the ICOR for Life side.');
    } else if (!icorRemote) {
      sections.icor.status = 'offline';
      note('icor', 'offline', META_DIR + '/manifest.json', 'Not checked: the latest ICOR for Life manifest could not be read' + (icorError ? ' (' + icorError + ')' : '') + '.',
        'Check the manifest URL and the token in the settings, then run the check again.');
    } else {
      const r = await runChecks({
        fs, hash, configDir, remote: icorRemote, local: local.icor.manifest, installedVersion: icorInstalled,
        repo: 'icor', metaDir: META_DIR, product: 'ICOR for Life Scaffold',
        agents: false, hostLinks: false, structure: true, syncFold: true,
        otherRemote: mypkaRemote || null, splitVersion: SPLIT_VERSION,
      });
      sections.icor.status = r.health;
      for (const f of r.findings) findings.push(f);
    }

    /* ---- myPKA ---- */
    if (!mode.team) {
      sections.mypka.status = 'elsewhere';
      note('mypka', 'mode', 'AGENTS.md', TEAM_ELSEWHERE, 'Nothing to do. Run the check in the team folder, or open it as its own vault, to see the team side.');
    } else if (!mypkaUrlSet) {
      note('mypka', 'offline', MYPKA_DIR + '/manifest.json', 'Not checked: no myPKA manifest URL is set.',
        'Set "Latest myPKA manifest URL" in the settings once myPKA is published. This plugin never guesses one.');
    } else if (!mypkaRemote) {
      sections.mypka.status = 'offline';
      note('mypka', 'offline', MYPKA_DIR + '/manifest.json', 'Not checked: the latest myPKA manifest could not be read' + (mypkaError ? ' (' + mypkaError + ')' : '') + '.',
        'Check the myPKA manifest URL in the settings, then run the check again. The ICOR for Life result above does not depend on it.');
    } else {
      if (mode.preSplit) {
        note('mypka', 'mode', MYPKA_DIR, 'Installed before the split (ICOR for Life Scaffold ' + icorInstalled + '). The AI team half is now myPKA: this section compares your team files against the latest myPKA, using your ICOR for Life manifest as the record of what you installed.',
          'Nothing is wrong. When you update, install myPKA\'s version folder `.mypka/` with the team files; the check then reads its own manifest.');
      }
      const r = await runChecks({
        fs, hash, configDir, remote: mypkaRemote,
        /* Before the split the team files were ICOR for Life files, so the
           old ICOR manifest is the honest record of what was installed. */
        local: local.mypka.manifest || (mode.preSplit ? local.icor.manifest : null),
        installedVersion: mypkaInstalled,
        repo: 'mypka', metaDir: MYPKA_DIR, product: 'myPKA',
        /* Before the split there is no `.mypka/` on ANY device, so its
           absence is not Obsidian Sync: no Sync line, and its own files are
           covered by the pre-split line above. */
        agents: true, hostLinks: true, structure: false, syncFold: !mode.preSplit,
        otherRemote: icorRemote || null, splitVersion: null,
        quietMissingVersion: mode.preSplit, metaNotInstalled: mode.preSplit, localVersion: !mode.preSplit,
      });
      sections.mypka.status = r.health;
      for (const f of r.findings) findings.push(f);
    }

    /* ---- the two together (mode A) ---- */
    if (mode.name === 'A') {
      const req = mypkaLocal ? parseRequires(mypkaLocal.requires) : null;
      const impl = icorLocal ? parseImplements(icorLocal.implements) : null;
      if (req && impl !== null) {
        if (impl < req.lo || impl >= req.hi) {
          findings.push({ kind: 'compat', severity: 'broken', path: META_DIR + '/manifest.json', repo: 'pair',
            message: 'The installed pair does not fit: ICOR for Life implements `icor-concepts/' + impl + '`, and myPKA requires `' + mypkaLocal.requires + '`. Session start will refuse (E_SCHEMA_MISMATCH).',
            action: 'Update the side that is behind so the two agree. The team\'s session start is the only thing that refuses; this check only reports it.' });
        }
      } else if (mode.mypkaDir && local.icor.manifest && !mode.preSplit) {
        note('pair', 'compat', MYPKA_DIR + '/manifest.json', 'Compatibility of the installed pair not verified: the `requires` in `' + MYPKA_DIR + '/manifest.json` or the `implements` in `' + META_DIR + '/manifest.json` is missing or not in the form this check reads.',
          'Nothing to do. The team\'s session start checks the pair itself.');
      }
      const latestImpl = icorRemote ? parseImplements(icorRemote.implements) : null;
      if (req && latestImpl !== null && (latestImpl < req.lo || latestImpl >= req.hi)) {
        findings.push({ kind: 'compat', severity: 'attention', path: MYPKA_DIR + '/manifest.json', repo: 'pair',
          message: 'The latest ICOR for Life implements `icor-concepts/' + latestImpl + '`, outside what your myPKA requires (`' + mypkaLocal.requires + '`).',
          action: 'Update myPKA before ICOR for Life, or the team\'s session start refuses the new content.' });
      }
    }
    /* Two products, one path: an upstream defect (T8). Reported, never judged. */
    if (icorRemote && mypkaRemote) {
      for (const p of icorRemote.files.keys()) {
        if (mypkaRemote.files.has(p)) note('pair', 'disjoint', p, 'Both ICOR for Life and myPKA ship this path, which the split says never happens.', 'Nothing to do on your side. Report it to support@myicor.com; the two releases have to agree on one owner.');
      }
    }
  }

  const counts = countFindings(findings);
  let health = counts.broken ? 'broken' : counts.attention ? 'attention' : 'ok';
  for (const s of [sections.icor, sections.mypka]) if (s.status === 'offline' && HEALTH_RANK.offline > HEALTH_RANK[health]) health = 'offline';
  return {
    suite: true, mode, sections, findings, counts, health,
    installedVersion: icorInstalled, latestVersion: sections.icor.latestVersion,
    mypkaInstalledVersion: mypkaInstalled, mypkaLatestVersion: sections.mypka.latestVersion,
  };
}

/* ---------------------------------------------- knowledge quality ---- */
/*
 * The scaffold's `Scripts/check-quality.py --write` measures the vault's
 * knowledge base (notes without a link, invented frontmatter fields,
 * orphans, unprocessed captures, ...) and writes the numbers to
 * `.icor-for-life/scripts/quality.json`, schema 1 (GL-1008: the machine
 * layer). This plugin never measures; it reads that one file and shows it,
 * in the report and on the dashboard. A missing file means "not run yet"
 * and is one sentence, not an error. A file with another schema, or one
 * that is not JSON, is refused with one sentence and never thrown. A file
 * older than seven days is shown with a stale marker.
 */

const PLUGIN_ID = 'icor-for-life-scaffold-check';
const QUALITY_PATH = META_DIR + '/scripts/quality.json';
const HISTORY_DIR = META_DIR + '/' + PLUGIN_ID;
const HISTORY_PATH = HISTORY_DIR + '/history.json';
const QUALITY_SCHEMA = 1;
const QUALITY_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const QUALITY_FINDINGS_PER_METRIC = 20;
const QUALITY_HEALTHS = ['ok', 'attention', 'broken'];
/* The metric ids the script writes, in the order the report shows them.
   A metric the script adds later is shown after these; one it drops is
   simply absent. Nothing here is required. */
const QUALITY_METRIC_IDS = ['notes_missing_link', 'enum_violations', 'missing_required_fields', 'invented_fields', 'orphans', 'dangling_links', 'documents_without_file', 'unprocessed_scratchpads', 'unprocessed_scratchpad_oldest_days', 'unprocessed_captures', 'unprocessed_capture_oldest_days', 'unconsumed_references', 'duplicate_entities'];
const QUALITY_COUNT_LABELS = { journal: 'Journal', notes: 'Notes', documents: 'Documents', people: 'People', companies: 'Companies', projects: 'Projects', goals: 'Goals', habits: 'Habits', topics: 'Topics', key_elements: 'Key elements', scratchpads: 'Scratchpads', inbox: 'Inbox' };
const NO_QUALITY_DATA = 'No knowledge quality data exists yet: run `Scripts/check-quality.py --write` (ICOR for Life Scaffold 1.18.0 or later) in the ICOR for Life Terminal, or ask your AI "check my notes", and the next Scaffold Check will show the numbers here.';
/* Severity as text, never an emoji: a report is read in the terminal and
   by screen readers as often as in Obsidian. */
const SEVERITY_GLYPH = { ok: 'ok', attention: '(!) attention', broken: '(x) broken' };
const QUALITY_TEXT = { ok: 'Knowledge ok', attention: 'Knowledge: attention', broken: 'Knowledge: broken', unknown: 'Knowledge: no data' };

const asText = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const asNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));
/* A metric id is also a frontmatter key, so it must look like one. */
const METRIC_ID = /^[a-z][a-z0-9_]{0,63}$/;

/* An empty quality result: status says why there is no data. */
function noQuality(status, message) {
  return { status, message, health: 'unknown', generated: null, ageDays: null, stale: false, scaffoldVersion: null, counts: {}, metrics: [], findings: [] };
}

/*
 * parseQuality(text, { now }) -> { status, message, health, generated,
 * ageDays, stale, scaffoldVersion, counts, metrics, findings }
 *
 * status: 'ok' (data follows), 'missing' (text was null: the script has
 * not run), 'invalid' (not JSON, or not an object), 'wrong-schema' (the
 * schema integer is not the one this plugin reads). Every field is
 * normalised: a metric without an id is dropped, a value that is not a
 * number is null, an unknown severity reads as 'ok' for a metric and
 * 'attention' for a finding. Never throws.
 */
function parseQuality(text, opts) {
  const o = Object.assign({ now: new Date() }, opts || {});
  if (text == null) return noQuality('missing', NO_QUALITY_DATA);
  const badJson = '`' + QUALITY_PATH + '` is not valid JSON, so the quality data is not shown; run `Scripts/check-quality.py --write` again to rewrite it.';
  let raw;
  try { raw = JSON.parse(String(text)); } catch (e) { return noQuality('invalid', badJson); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return noQuality('invalid', badJson);
  if (raw.schema !== QUALITY_SCHEMA) {
    const seen = raw.schema === undefined ? 'no schema' : 'schema ' + JSON.stringify(raw.schema);
    return noQuality('wrong-schema', '`' + QUALITY_PATH + '` carries ' + seen + ' and this plugin reads schema ' + QUALITY_SCHEMA + ', so the quality data is not shown; update the plugin or the script so the two agree.');
  }
  const health = QUALITY_HEALTHS.includes(raw.health) ? raw.health : 'unknown';
  const generated = typeof raw.generated === 'string' && raw.generated.trim() ? raw.generated.trim() : null;
  const t = generated ? Date.parse(generated) : NaN;
  const ageMs = Number.isFinite(t) ? o.now.getTime() - t : null;
  const ageDays = ageMs === null ? null : Math.max(0, Math.floor(ageMs / 86400000));
  const stale = ageMs === null || ageMs > QUALITY_STALE_MS;
  const counts = {};
  if (raw.counts && typeof raw.counts === 'object') {
    for (const k of Object.keys(raw.counts)) { const n = asNumber(raw.counts[k]); if (n !== null && METRIC_ID.test(k)) counts[k] = n; }
  }
  const metrics = [];
  const seenIds = new Set();
  for (const m of Array.isArray(raw.metrics) ? raw.metrics : []) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !METRIC_ID.test(m.id) || seenIds.has(m.id)) continue;
    seenIds.add(m.id);
    const th = m.threshold && typeof m.threshold === 'object' ? { attention: asNumber(m.threshold.attention), broken: asNumber(m.threshold.broken) } : null;
    metrics.push({ id: m.id, label: asText(m.label).trim() || m.id, value: asNumber(m.value), unit: asText(m.unit).trim(), severity: QUALITY_HEALTHS.includes(m.severity) ? m.severity : 'ok', threshold: th, sop: asText(m.sop).trim() });
  }
  const findings = [];
  for (const f of Array.isArray(raw.findings) ? raw.findings : []) {
    if (!f || typeof f !== 'object') continue;
    findings.push({ metric: asText(f.metric), severity: QUALITY_HEALTHS.includes(f.severity) ? f.severity : 'attention', path: asText(f.path), message: asText(f.message), action: asText(f.action) });
  }
  return { status: 'ok', message: '', health, generated, ageDays, stale, scaffoldVersion: asText(raw.scaffold_version) || null, counts, metrics, findings };
}

/* The quality file through the engine's fs interface: absent is
   'missing', unreadable is 'invalid'. Never throws. */
async function loadQuality(fs, opts) {
  let present = false;
  try { present = await fs.exists(QUALITY_PATH); } catch (e) { present = false; }
  if (!present) return parseQuality(null, opts);
  let text;
  try { text = await fs.read(QUALITY_PATH); } catch (e) { return noQuality('invalid', '`' + QUALITY_PATH + '` exists but could not be read, so the quality data is not shown.'); }
  return parseQuality(text, opts);
}

/* "7 notes", "1 day", "4 days", "0". The script writes the unit in the
   plural, so a value of one is singularised here: presentation is the
   plugin's job, not the script's. A unit ending in "ss" is left alone. */
function metricValueText(m) {
  if (m.value === null) return 'unknown';
  if (!m.unit) return String(m.value);
  const unit = m.value === 1 && /[^s]s$/.test(m.unit) ? m.unit.slice(0, -1) : m.unit;
  return String(m.value) + ' ' + unit;
}

/* The metrics in QUALITY_METRIC_IDS order, then any the script added. */
function orderedMetrics(q) {
  const known = QUALITY_METRIC_IDS.map((id) => q.metrics.find((m) => m.id === id)).filter(Boolean);
  const extra = q.metrics.filter((m) => !QUALITY_METRIC_IDS.includes(m.id));
  return known.concat(extra);
}

/* One line for the counts: "Journal 412, Notes 96, ...". '' when none. */
function countsText(q) {
  const parts = [];
  for (const k of Object.keys(QUALITY_COUNT_LABELS)) if (k in q.counts) parts.push(QUALITY_COUNT_LABELS[k] + ' ' + q.counts[k]);
  for (const k of Object.keys(q.counts)) if (!(k in QUALITY_COUNT_LABELS)) parts.push(k + ' ' + q.counts[k]);
  return parts.join(', ');
}

/* The frontmatter keys the report carries for the quality data, so a Base
   or a script can read them without opening quality.json: quality_health,
   quality_generated, quality_stale, then one key per metric id with its
   value. Without data the first two say so and the rest are absent. */
function qualityFrontmatter(q) {
  const L = [];
  if (!q || q.status !== 'ok') { L.push('quality_health: unknown'); L.push('quality_generated: unknown'); return L; }
  L.push('quality_health: ' + q.health);
  L.push('quality_generated: ' + (q.generated || 'unknown'));
  L.push('quality_stale: ' + (q.stale ? 'true' : 'false'));
  for (const m of orderedMetrics(q)) if (m.value !== null) L.push(m.id + ': ' + m.value);
  return L;
}

/* The "Knowledge quality" section of the report as lines: the heading with
   the health, the stale marker when the numbers are old, the metric table,
   the counts, and the findings grouped by metric (twenty per metric, then a
   "+n more" line), in the report's own idiom. Without data the section is
   the one sentence that says how to get some. */
function renderQuality(q) {
  const L = [];
  if (!q || q.status !== 'ok') {
    L.push('## Knowledge quality (' + (q && q.status !== 'missing' ? 'unreadable' : 'no data yet') + ')');
    L.push('');
    L.push(q ? q.message : NO_QUALITY_DATA);
    L.push('');
    return L;
  }
  L.push('## Knowledge quality (' + q.health + ')');
  L.push('');
  const when = q.generated ? 'on ' + q.generated : 'at an unknown time';
  const version = q.scaffoldVersion ? ' against scaffold ' + q.scaffoldVersion : '';
  L.push('Measured by `Scripts/check-quality.py` ' + when + version + '. This check only reads the numbers; the script measures.');
  if (q.stale) {
    L.push('');
    L.push('**Stale:** ' + (q.ageDays === null ? 'the file carries no readable `generated` date' : 'the numbers are ' + q.ageDays + ' days old') + '. Run `Scripts/check-quality.py --write` again for current ones.');
  }
  L.push('');
  const metrics = orderedMetrics(q);
  if (metrics.length) {
    L.push('| Metric | Value | Severity |');
    L.push('|---|---|---|');
    for (const m of metrics) L.push('| ' + m.label + ' | ' + metricValueText(m) + ' | ' + (SEVERITY_GLYPH[m.severity] || m.severity) + ' |');
    L.push('');
  }
  const counted = countsText(q);
  if (counted) { L.push('Counted: ' + counted + '.'); L.push(''); }

  const byMetric = new Map();
  for (const f of q.findings) { if (!byMetric.has(f.metric)) byMetric.set(f.metric, []); byMetric.get(f.metric).push(f); }
  const order = metrics.map((m) => m.id).concat([...byMetric.keys()].filter((id) => !metrics.some((m) => m.id === id)));
  for (const id of order) {
    const rows = byMetric.get(id);
    if (!rows || !rows.length) continue;
    const m = metrics.find((x) => x.id === id);
    L.push('### ' + (m ? m.label : id) + ' (' + rows.length + ')');
    L.push('');
    if (m && m.sop) { L.push('Repair procedure: ' + m.sop + '.'); L.push(''); }
    for (const f of rows.slice(0, QUALITY_FINDINGS_PER_METRIC)) {
      L.push('- **`' + f.path + '`** ' + f.message);
      L.push('  - Do: ' + f.action);
    }
    if (rows.length > QUALITY_FINDINGS_PER_METRIC) L.push('- +' + (rows.length - QUALITY_FINDINGS_PER_METRIC) + ' more in `' + QUALITY_PATH + '`');
    L.push('');
  }
  return L;
}

/* ------------------------------------------------------ the harness ---- */
/*
 * `scaffold-init.py doctor --json` writes what it found about each AI host
 * to `.icor-for-life/scripts/harness.json`, schema 1 (GL-1008: the machine
 * layer). Per host: what was detected, what is installed, whether the host
 * trusts this folder, whether the guards have been watched go red, and
 * what that host cannot do at all. This plugin never inspects a host; it
 * reads that one file and shows it.
 *
 * A missing file means "the generator has not been asked yet" and is one
 * sentence with the command in it, never an error. Another schema, or
 * anything that is not JSON, is refused with one sentence and never
 * thrown.
 */
/* Since the split (0.7.0) the harness is TEAM state and lives with the team:
   `scaffold-init.py` writes `.mypka/state/harness.json` (j5d). The old
   location is read second, labelled, so a vault whose generator has not run
   since the move still shows its hosts. */
const HARNESS_PATH = MYPKA_DIR + '/state/harness.json';
const HARNESS_PATH_OLD = META_DIR + '/scripts/harness.json';
const HARNESS_SCHEMA = 1;
const HARNESS_HOST_ORDER = ['claude-code', 'codex', 'gemini', 'cursor'];
const HARNESS_HOST_LABELS = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', cursor: 'Cursor' };
const HARNESS_TRUSTED = ['yes', 'no', 'unknown'];
const HARNESS_TESTED = ['ok', 'red', 'absent', 'error', 'skipped', 'unsupported'];
/* The words a person reads, in place of the file's machine values. */
const HARNESS_TESTED_TEXT = { ok: 'green', red: 'RED', absent: 'no suite here', error: 'could not run', skipped: 'not run', unsupported: 'not applicable' };
/* The trust word in the table is short on purpose; the reason is a line of
   its own under it, because a sentence a member has to act on does not belong
   in a cell that scrolls sideways. */
const HARNESS_TRUSTED_TEXT = { yes: 'yes', no: 'NOT TRUSTED', unknown: 'unknown' };
const HARNESS_TEXT = { ok: 'Harness ok', attention: 'Harness: attention', unknown: 'Harness: no data', elsewhere: 'Harness: team elsewhere' };
const NO_HARNESS_DATA = 'No harness data exists yet: run `python3 "' + GEN_SCRIPT + '" doctor --json` (ICOR for Life Scaffold 1.23.0 or later) in the ICOR for Life Terminal, and the next Scaffold Check will show which AI hosts this vault is wired to. It writes `' + HARNESS_PATH + '`.';

/* In a content vault the generator is not here to run: the team, and its
   harness, live in their own folder (mode B). Said as a fact, never as a
   missing file. */
const HARNESS_ELSEWHERE = 'The myPKA team lives elsewhere, so its harness is not read here. Run the check in the team folder to see which AI hosts the team is wired to.';

function noHarness(status, message) {
  return { status, message, health: 'unknown', generated: null, scaffoldVersion: null, mypkaVersion: null, path: null, oldLocation: false, skills: null, files: null, tests: null, problems: [], notes: [], hosts: [] };
}

const asList = (v) => (Array.isArray(v) ? v.map(asText).map((s) => s.trim()).filter(Boolean) : []);

/*
 * parseHarness(text) -> { status, message, health, generated,
 * scaffoldVersion, skills, files, tests, problems, notes, hosts }
 *
 * status: 'ok', 'missing' (text was null), 'invalid', 'wrong-schema'.
 * health is 'attention' when the generator reported a problem or the red
 * tests came back RED, and 'ok' otherwise: those are the two states a
 * person can act on. A host entry without a known id is dropped, because
 * a row whose first column is a guess is worse than no row.
 * Never throws.
 */
function parseHarness(text, opts) {
  const at = (opts && opts.path) || HARNESS_PATH;
  if (text == null) return noHarness('missing', NO_HARNESS_DATA);
  const badJson = '`' + at + '` is not valid JSON, so the harness is not shown; run `scaffold-init.py doctor --json` again to rewrite it.';
  let raw;
  try { raw = JSON.parse(String(text)); } catch { return noHarness('invalid', badJson); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return noHarness('invalid', badJson);
  if (raw.schema !== HARNESS_SCHEMA) {
    const seen = raw.schema === undefined ? 'no schema' : 'schema ' + JSON.stringify(raw.schema);
    return noHarness('wrong-schema', '`' + at + '` carries ' + seen + ' and this plugin reads schema ' + HARNESS_SCHEMA + ', so the harness is not shown; update the plugin or the scaffold so the two agree.');
  }
  const num = (o, k) => (o && typeof o === 'object' ? asNumber(o[k]) : null);
  const skills = raw.skills && typeof raw.skills === 'object'
    ? { count: num(raw.skills, 'count'), tokens: num(raw.skills, 'tokens'), budget: num(raw.skills, 'budget') } : null;
  const files = raw.files && typeof raw.files === 'object'
    ? { generated: num(raw.files, 'generated'), handKept: num(raw.files, 'hand_kept'), orphans: num(raw.files, 'orphans') } : null;
  const tests = raw.tests && typeof raw.tests === 'object'
    ? { status: HARNESS_TESTED.includes(raw.tests.status) ? raw.tests.status : 'error', summary: asText(raw.tests.summary).trim(), skips: asList(raw.tests.skips) } : null;
  const hosts = [];
  const seen = new Set();
  for (const h of Array.isArray(raw.hosts) ? raw.hosts : []) {
    if (!h || typeof h !== 'object' || typeof h.id !== 'string') continue;
    const id = h.id.trim();
    if (!HARNESS_HOST_LABELS[id] || seen.has(id)) continue;
    seen.add(id);
    hosts.push({
      id,
      label: HARNESS_HOST_LABELS[id],
      detected: asList(h.detected),
      installed: asText(h.installed).trim(),
      trusted: HARNESS_TRUSTED.includes(h.trusted) ? h.trusted : 'unknown',
      trustedNote: asText(h.trusted_note).trim(),
      tested: HARNESS_TESTED.includes(h.tested) ? h.tested : 'error',
      unsupported: asList(h.unsupported),
      /* Published only by a host that has a sandbox, so `sandbox` being
         absent is the normal case and not a false. */
      sandbox: h.sandbox === true,
      sandboxNote: asText(h.sandbox_note).trim(),
    });
  }
  hosts.sort((a, b) => HARNESS_HOST_ORDER.indexOf(a.id) - HARNESS_HOST_ORDER.indexOf(b.id));
  const problems = asList(raw.problems);
  /* A host that is not trusted lifts the health, because "Harness ok" printed
     above a line reading "guards off in codex exec until trusted" is a green
     reachable while the thing is false, which is the exact failure this whole
     block exists to stop. `unknown` does not lift it: not being able to read a
     file is not the same as knowing something is wrong. */
  const untrusted = hosts.some((x) => x.trusted === 'no');
  const health = problems.length || untrusted || (tests && tests.status === 'red') ? 'attention' : 'ok';
  return {
    status: 'ok', message: '', health,
    generated: asText(raw.generated).trim() || null,
    scaffoldVersion: asText(raw.scaffold_version).trim() || null,
    /* Additive, from the myPKA generator: the team's own version, since in
       mode B `scaffold_version` names no version at all. */
    mypkaVersion: asText(raw.mypka_version).trim() || null,
    path: at, oldLocation: at === HARNESS_PATH_OLD,
    skills, files, tests, problems, notes: asList(raw.notes), hosts,
  };
}

/* The harness file through the engine's fs interface: absent is 'missing',
   unreadable is 'invalid'. Never throws. */
async function loadHarness(fs, opts) {
  if (opts && opts.teamHere === false) return noHarness('elsewhere', HARNESS_ELSEWHERE);
  for (const path of [HARNESS_PATH, HARNESS_PATH_OLD]) {
    let present = false;
    try { present = await fs.exists(path); } catch { present = false; }
    if (!present) continue;
    let text;
    try { text = await fs.read(path); } catch { return noHarness('invalid', '`' + path + '` exists but could not be read, so the harness is not shown.'); }
    return parseHarness(text, { path });
  }
  return parseHarness(null);
}

/* The frontmatter keys the report carries for the harness, so a Base can
   read them without opening the file. */
function harnessFrontmatter(h) {
  const L = [];
  if (!h || h.status !== 'ok') { L.push('harness_health: unknown'); L.push('harness_generated: unknown'); return L; }
  L.push('harness_health: ' + h.health);
  L.push('harness_generated: ' + (h.generated || 'unknown'));
  L.push('harness_hosts_detected: ' + h.hosts.filter((x) => x.detected.length).length);
  if (h.skills && h.skills.count !== null) L.push('harness_skills: ' + h.skills.count);
  if (h.tests) L.push('harness_tests: ' + h.tests.status);
  const untrusted = h.hosts.filter((x) => x.trusted === 'no').map((x) => x.id);
  if (untrusted.length) L.push('harness_untrusted_hosts: ' + untrusted.join(', '));
  return L;
}

/* The "Harness" section of the report as lines: one row per host, then the
   counts and whatever the generator could not settle. Without data the
   section is the one sentence that says how to get some. */
function renderHarness(h) {
  const L = [];
  if (!h || h.status !== 'ok') {
    L.push('## Harness (' + (h && h.status === 'elsewhere' ? 'team lives elsewhere' : h && h.status !== 'missing' ? 'unreadable' : 'no data yet') + ')');
    L.push('');
    L.push(h ? h.message : NO_HARNESS_DATA);
    L.push('');
    return L;
  }
  L.push('## Harness (' + h.health + ')');
  L.push('');
  L.push('Which AI hosts this vault is wired to, read from `' + (h.path || HARNESS_PATH) + '` as `scaffold-init.py doctor --json` wrote it '
    + (h.generated ? 'on ' + h.generated : 'at an unknown time')
    + (h.mypkaVersion ? ' against myPKA ' + h.mypkaVersion : h.scaffoldVersion ? ' against scaffold ' + h.scaffoldVersion : '') + '. This check only reads it; the generator looks.');
  L.push('');
  if (h.oldLocation) {
    L.push('**Old location:** this file is where the generator wrote it before the split. Run `python3 "' + GEN_SCRIPT + '" doctor --json` again, and it writes `' + HARNESS_PATH + '`, which this check reads first.');
    L.push('');
  }
  if (h.hosts.length) {
    L.push('| Host | Detected | Installed | Trusted | Guards tested | Unsupported |');
    L.push('|---|---|---|---|---|---|');
    for (const x of h.hosts) {
      L.push('| ' + x.label
        + ' | ' + (x.detected.length ? x.detected.join(', ') : 'no')
        + ' | ' + (x.installed || 'nothing')
        + ' | ' + (HARNESS_TRUSTED_TEXT[x.trusted] || x.trusted)
        + ' | ' + (HARNESS_TESTED_TEXT[x.tested] || x.tested)
        + ' | ' + (x.unsupported.length ? x.unsupported.join('; ') : 'nothing') + ' |');
    }
    L.push('');
  }
  /* One line per thing a member can act on, under the table rather than in
     it. A host that is not trusted is the one state that costs something and
     says nothing: Codex asks about hooks only in an interactive session, so
     `codex exec` runs none of them and prints nothing about it, and a
     terminal with every guard off looks exactly like one with them on. */
  for (const x of h.hosts) {
    if (x.trusted === 'no' && x.trustedNote) L.push('- **' + x.label + ', trust:** ' + x.trustedNote);
    else if (x.trusted === 'unknown' && x.trustedNote && x.id === 'codex') L.push('- **' + x.label + ', trust:** ' + x.trustedNote);
  }
  for (const x of h.hosts) {
    if (x.sandbox && x.sandboxNote) L.push('- **' + x.label + ', sandbox:** ' + x.sandboxNote);
  }
  if (h.hosts.some((x) => (x.trusted !== 'yes' && x.trustedNote && (x.trusted === 'no' || x.id === 'codex')) || (x.sandbox && x.sandboxNote))) L.push('');

  const bits = [];
  if (h.skills && h.skills.count !== null) {
    bits.push(h.skills.count + ' skill' + (h.skills.count === 1 ? '' : 's')
      + (h.skills.tokens !== null && h.skills.budget !== null ? ', about ' + h.skills.tokens + ' startup tokens of a ' + h.skills.budget + ' budget' : ''));
  }
  if (h.files) {
    if (h.files.generated !== null) bits.push(h.files.generated + ' generated file' + (h.files.generated === 1 ? '' : 's'));
    if (h.files.handKept !== null) bits.push(h.files.handKept + ' shim' + (h.files.handKept === 1 ? '' : 's') + ' held by hand');
    if (h.files.orphans !== null) bits.push(h.files.orphans + ' orphan' + (h.files.orphans === 1 ? '' : 's'));
  }
  if (bits.length) { L.push(bits.join(', ') + '.'); L.push(''); }
  if (h.tests) {
    /* The summary often already says what the status says, and printing
       both reads as a stutter ("not run. not run"). */
    const word = HARNESS_TESTED_TEXT[h.tests.status] || h.tests.status;
    const sum = h.tests.summary;
    L.push('Red tests: ' + (sum && !sum.toLowerCase().includes(word.toLowerCase()) ? word + '. ' + sum : (sum || word + '.')));
    for (const skip of h.tests.skips) L.push('- ' + skip);
    L.push('');
    /* Only a green needs its limits stated. Saying what a green does not
       prove under a suite that never ran would be a caveat on nothing. */
    if (h.tests.status === 'ok') {
      L.push('What a green here does not prove: that any host reads any of it, that a hook fires, or that a skill gets selected. It proves the guards refuse what they must refuse.');
      L.push('');
    }
  }
  for (const pr of h.problems) { L.push('- **Problem:** ' + pr); }
  if (h.problems.length) L.push('');
  for (const n of h.notes) { L.push('- Note: ' + n); }
  if (h.notes.length) L.push('');
  return L;
}

/* The heading a group of findings gets, when the kind's own name is not
   what a person would call it. A kind not in here keeps its own name, which
   is what every kind did before these three arrived. */
const KIND_LABELS = { generated: 'Generated harness layer', 'harness-link': 'Host skill links', scratchpad: 'Daily Scratchpad' };

/* Findings that say the same "nothing to do" are counted, not listed. On a
   vault with eight agents that is twenty-two lines each saying nothing is
   wrong, and they bury the one line that says something is. Only findings
   carrying a `collapse` key do this, and only when there is more than one:
   a summary of a single item is longer than the item. */
const COLLAPSE_SUMMARY = {
  'generated-intact': (n) => '**' + n + ' generated files, all current.** Each is written from your own vault by `scaffold-init.py apply` and still matches the hash in its own header, so each differs from the scaffold only because your source does. Nothing to do.',
};

/* One severity group's findings as lines, grouped by kind so seventy
   missing files read as "6 guidelines, 13 SOPs" with the list under each,
   rather than seventy lines. Order is the order the kinds first appear in,
   which is the manifest's order. `h` is the heading prefix for the kinds. */
function findingGroupLines(rows, h) {
  const L = [];
  const groupOf = (f) => (f.kind === 'file' ? f.fileKind || 'file' : f.kind);
  const kinds = [];
  for (const f of rows) if (!kinds.includes(groupOf(f))) kinds.push(groupOf(f));
  for (const kind of kinds) {
    const sub = rows.filter((f) => groupOf(f) === kind);
    if (kinds.length > 1) { L.push(h + ' ' + (KIND_LABELS[kind] || kind) + ' (' + sub.length + ')'); L.push(''); }
    const counted = new Map();
    for (const f of sub) {
      if (f.collapse && COLLAPSE_SUMMARY[f.collapse] && sub.filter((x) => x.collapse === f.collapse).length > 1) {
        counted.set(f.collapse, (counted.get(f.collapse) || 0) + 1);
        continue;
      }
      L.push('- **`' + f.path + '`** ' + f.message);
      L.push('  - Do: ' + f.action);
    }
    for (const [key, n] of counted) L.push('- ' + COLLAPSE_SUMMARY[key](n));
    L.push('');
  }
  return L;
}

const SEVERITY_GROUPS = [
  ['broken', 'Broken', 'Structure the scaffold relies on. Fix these first.'],
  ['attention', 'Attention', 'Things to do, in the order they appear.'],
  ['info', 'Info', 'Worth knowing. Nothing to do unless you want to.'],
];

/* Every severity group of `findings`, headed at level `h` ("##"), kinds one
   level below. */
function severityLines(findings, h) {
  const L = [];
  for (const [sev, title, lead] of SEVERITY_GROUPS) {
    const rows = findings.filter((f) => f.severity === sev);
    if (!rows.length) continue;
    L.push(h + ' ' + title + ' (' + rows.length + ')');
    L.push('');
    L.push(lead);
    L.push('');
    for (const line of findingGroupLines(rows, h + '#')) L.push(line);
  }
  return L;
}

const SECTION_STATUS_TEXT = { ok: 'ok', attention: 'attention', broken: 'broken', offline: 'not checked, offline', 'not-checked': 'not checked', elsewhere: 'lives elsewhere' };

/* The paragraph for your AI. The single-product wording (before 0.7.0) and
   the two-product one share every rule; the second one names which product
   a missing file comes from, because copying a team file from ICOR for
   Life, or a content file from myPKA, is exactly the mistake the split
   makes easy. */
function aiPrompt(suite) {
  const copy = suite
    ? 'for a missing canonical file, copy it from the latest release of the product whose section lists it: the ICOR for Life Scaffold for the ICOR for Life (content) section, myPKA for the myPKA (team) section, never from the other one; a file the report does not call a leftover is not one, so never delete a team file because ICOR for Life stopped shipping it, it moved to myPKA; for an `.update` file, show me the difference, merge what I choose into my file, then delete the `.update` file;'
    : 'for a missing canonical file, copy it from the latest ICOR for Life Scaffold;';
  return 'Read the Scaffold Check report at the path of this note. Fix every Broken item, then every Attention item, in order. Rules: never overwrite a file the report says I edited; for a leftover, delete it only after reading the changelog line the report cites; '
    + copy + ' never change or reuse a `myicor_id`, an agent keeps its id for life; never hand-edit anything under Generated harness layer, change the source the report names and run `python3 "' + GEN_SCRIPT + '" apply` instead. Show me each change before you make it. Then read the Knowledge quality section and run SOP-1014 for what it lists; propose repairs, apply only after I say yes.';
}

/* The report note. Frontmatter carries the numbers so a Base or a script can
   read it; the body is for the person, grouped by what to do. `result` is a
   runSuite() result (two sections, 0.7.0) or a runChecks() one (one
   product, the shape before 0.7.0). opts.quality is a parseQuality()
   result; absent, the quality section says there is no data yet. */
function renderReport(result, opts) {
  const o = Object.assign({ now: new Date(), today: '', manifestUrl: '', mypkaManifestUrl: '', vaultName: '', quality: null, harness: null }, opts || {});
  const suite = result && result.suite === true;
  /* The caller passes the day it named the file after, so the note and its
     own filename cannot disagree. Without one, the local day of `now`. */
  const stamp = ISO_DAY_RE.test(String(o.today)) ? String(o.today) : localDayStr(o.now);
  const L = [];
  L.push('---');
  L.push('type: scaffold-check');
  L.push('date: ' + stamp);
  L.push('health: ' + result.health);
  if (suite) L.push('mode: ' + result.mode.name);
  L.push('installed_version: ' + (result.installedVersion || 'unknown'));
  L.push('latest_version: ' + (result.latestVersion || 'unknown'));
  if (suite) {
    L.push('mypka_installed_version: ' + (result.mypkaInstalledVersion || 'unknown'));
    L.push('mypka_latest_version: ' + (result.mypkaLatestVersion || 'unknown'));
  }
  L.push('broken: ' + result.counts.broken);
  L.push('attention: ' + result.counts.attention);
  L.push('info: ' + result.counts.info);
  for (const line of qualityFrontmatter(o.quality)) L.push(line);
  for (const line of harnessFrontmatter(o.harness)) L.push(line);
  L.push('---');
  L.push('');
  L.push('# Scaffold Check, ' + stamp);
  L.push('');
  const verdict = result.health === 'ok' ? 'Everything the scaffold relies on is present and current.'
    : result.health === 'broken' ? 'Something the scaffold relies on is missing. Fix the broken items first; the plugins and the AI Team assume they exist.'
    : result.health === 'offline' ? 'Part of this check could not run: a latest manifest could not be read. What could be checked is below.'
    : 'Nothing is broken. There are things to do.';
  L.push('**' + verdict + '**');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  if (suite) {
    L.push('| This vault | ' + (MODE_TEXT[result.mode.name] || result.mode.name) + ' |');
    L.push('| ICOR for Life installed | ' + (result.installedVersion || 'unknown') + ' |');
    L.push('| ICOR for Life latest | ' + (result.latestVersion || 'unknown') + ' |');
    L.push('| myPKA installed | ' + (result.mypkaInstalledVersion || 'unknown') + ' |');
    L.push('| myPKA latest | ' + (result.mypkaLatestVersion || 'unknown') + ' |');
  } else {
    L.push('| Installed version | ' + (result.installedVersion || 'unknown') + ' |');
    L.push('| Latest version | ' + (result.latestVersion || 'unknown') + ' |');
  }
  L.push('| Broken | ' + result.counts.broken + ' |');
  L.push('| Attention | ' + result.counts.attention + ' |');
  L.push('| Info | ' + result.counts.info + ' |');
  L.push('');
  L.push('Read-only: this check changed nothing. Your own files, the ones the scaffold never shipped, are not counted.');
  L.push('');

  if (!suite) {
    for (const line of severityLines(result.findings, '##')) L.push(line);
  } else {
    for (const repo of ['icor', 'mypka']) {
      const s = result.sections[repo];
      const rows = result.findings.filter((f) => f.repo === repo);
      L.push('## ' + s.title + ' (' + (SECTION_STATUS_TEXT[s.status] || s.status) + ')');
      L.push('');
      L.push('Installed ' + (s.installedVersion || 'unknown') + ', latest ' + (s.latestVersion || 'unknown') + '.');
      L.push('');
      if (!rows.length) { L.push('Nothing to report.'); L.push(''); }
      for (const line of severityLines(rows, '###')) L.push(line);
    }
    const pair = result.findings.filter((f) => f.repo === 'pair');
    if (pair.length) {
      L.push('## Both together');
      L.push('');
      for (const line of severityLines(pair, '###')) L.push(line);
    }
  }

  for (const line of renderQuality(o.quality)) L.push(line);
  for (const line of renderHarness(o.harness)) L.push(line);

  L.push('## For your AI');
  L.push('');
  L.push('Paste this into your AI session to have the fixes done for you. Everything above is the input; nothing here changes a file on its own.');
  L.push('');
  L.push('```');
  L.push(aiPrompt(suite));
  L.push('```');
  L.push('');
  if (o.manifestUrl) {
    L.push((suite ? 'Latest ICOR for Life manifest: ' : 'Latest manifest: ') + o.manifestUrl);
    L.push('');
  }
  if (suite && o.mypkaManifestUrl) {
    L.push('Latest myPKA manifest: ' + o.mypkaManifestUrl);
    L.push('');
  }
  return L.join('\n');
}

/* ------------------------------------------------------ run history ---- */
/*
 * One record per completed run, appended to
 * `.icor-for-life/icor-for-life-scaffold-check/history.json` (this
 * plugin's own subfolder of the machine layer, GL-1008), capped at the
 * last ninety. It is state, not a setting: data.json keeps the settings
 * and the two status-bar fields, this file feeds the dashboard's trend
 * lines. The file is regenerable and per device; a missing or malformed
 * one starts fresh and never throws.
 */

const HISTORY_SCHEMA = 1;
const HISTORY_CAP = 90;

function emptyHistory() { return { schema: HISTORY_SCHEMA, runs: [] }; }

/* The history file's text -> { schema: 1, runs }. null (absent), broken
   JSON, another schema or a shape without a runs array all start fresh;
   a run without an `at` string is dropped. */
function parseHistory(text) {
  if (text == null) return emptyHistory();
  let raw;
  try { raw = JSON.parse(String(text)); } catch (e) { return emptyHistory(); }
  if (!raw || typeof raw !== 'object' || raw.schema !== HISTORY_SCHEMA || !Array.isArray(raw.runs)) return emptyHistory();
  return { schema: HISTORY_SCHEMA, runs: raw.runs.filter((r) => r && typeof r === 'object' && typeof r.at === 'string') };
}

async function loadHistory(fs) {
  let present = false;
  try { present = await fs.exists(HISTORY_PATH); } catch (e) { present = false; }
  if (!present) return emptyHistory();
  let text = null;
  try { text = await fs.read(HISTORY_PATH); } catch (e) { text = null; }
  return parseHistory(text);
}

/* The record for one run: the scaffold result plus the quality numbers
   that were on disk at the time (an empty `metrics` when there were none). */
function runRecord(result, quality, now) {
  const metrics = {};
  if (quality && quality.status === 'ok') for (const m of quality.metrics) if (m.value !== null) metrics[m.id] = m.value;
  const rec = {
    at: (now || new Date()).toISOString(),
    health: result.health,
    broken: result.counts.broken,
    attention: result.counts.attention,
    info: result.counts.info,
    quality_health: quality && quality.status === 'ok' ? quality.health : 'unknown',
    metrics,
  };
  /* Since 0.7.0, per product. parseHistory ignores keys it does not know,
     so HISTORY_SCHEMA stays 1 and an older build still reads the file. */
  if (result && result.suite === true) {
    rec.mode = result.mode.name;
    rec.repos = {};
    for (const repo of ['icor', 'mypka']) {
      const s = result.sections[repo];
      const c = countFindings(result.findings.filter((f) => f.repo === repo));
      rec.repos[repo] = { status: s.status, installed: s.installedVersion || null, latest: s.latestVersion || null, broken: c.broken, attention: c.attention, info: c.info };
    }
  }
  return rec;
}

/* The run history lives in this plugin's subfolder of `.icor-for-life/`,
   and is written only when that folder is already there. A myPKA team
   folder opened as a vault has none, and creating one would plant an ICOR
   for Life marker in a folder that is not ICOR for Life. */
async function historyWritable(fs) {
  try { return !!(await fs.exists(META_DIR)); } catch (e) { return false; }
}

/* history + record -> a new history holding the last HISTORY_CAP runs.
   The input is taken through parseHistory's rules, so a caller can hand
   it anything and still get a well-formed file back. */
function appendRun(history, record) {
  const h = history && typeof history === 'object' && history.schema === HISTORY_SCHEMA && Array.isArray(history.runs) ? parseHistory(JSON.stringify(history)) : emptyHistory();
  const runs = h.runs.concat([record]);
  return { schema: HISTORY_SCHEMA, runs: runs.slice(Math.max(0, runs.length - HISTORY_CAP)) };
}

/* One metric's values over the last `limit` runs, oldest first, skipping
   runs that did not carry it. */
function metricSeries(history, id, limit) {
  const runs = (history && Array.isArray(history.runs) ? history.runs : []).slice(-(limit || 30));
  const out = [];
  for (const r of runs) { const v = r.metrics && asNumber(r.metrics[id]); if (v !== null && v !== undefined) out.push(v); }
  return out;
}

/* The `d` of an SVG path for a sparkline over `values`, left to right,
   inside width x height with a one unit margin. One value draws as a flat
   line; a series that never changes sits at mid height. '' for no values,
   so a caller can skip the SVG. */
function sparklinePath(values, width, height) {
  const v = (values || []).filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (!v.length) return '';
  const w = width || 60, h = height || 16, pad = 1;
  const pts = v.length === 1 ? [v[0], v[0]] : v;
  const min = Math.min(...pts), max = Math.max(...pts);
  const step = (w - 2 * pad) / (pts.length - 1);
  return pts.map((n, i) => {
    const x = pad + i * step;
    const y = max === min ? h / 2 : pad + (h - 2 * pad) * (1 - (n - min) / (max - min));
    return (i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
}

const engine = { normalizeManifest, kindOf, preRelease, compareCore, parseRequires, parseImplements, tokenAllowedFor, isDescriptor, detectMode, readLocalPair, readLocalPairs, runSuite, historyWritable, countFindings, MYPKA_DIR, CONTENT_ROOMS, SPLIT_VERSION, HARNESS_PATH_OLD, HARNESS_ELSEWHERE, TEAM_ELSEWHERE, CONTENT_ELSEWHERE, MODE_TEXT, TOKEN_HOSTS, localDayStr, todayStr, localDayOfIso, parseVersion, compareVersions, baseFolders, scratchpadProblem, removalsSince, readFrontmatter, isTemplateName, runChecks, renderReport, parseQuality, loadQuality, qualityFrontmatter, renderQuality, orderedMetrics, metricValueText, countsText, parseHistory, loadHistory, runRecord, appendRun, metricSeries, sparklinePath, generatedState, generatedHeaderLine, isHarnessPath, isPartlyGenerated, isMachineState, parseHarness, loadHarness, harnessFrontmatter, renderHarness, KIND_LABELS, COLLAPSE_SUMMARY, META_DIR, AGENTS_DIR, NIL_ID, UUID_V4, PLUGIN_ID, QUALITY_PATH, HISTORY_DIR, HISTORY_PATH, QUALITY_SCHEMA, QUALITY_METRIC_IDS, QUALITY_FINDINGS_PER_METRIC, HISTORY_CAP, NO_QUALITY_DATA, SEVERITY_GLYPH, QUALITY_TEXT, QUALITY_COUNT_LABELS, GEN_MARK, GEN_SCRIPT, HARNESS_PATH, HARNESS_SCHEMA, HARNESS_TEXT, HARNESS_TESTED_TEXT, HARNESS_TRUSTED_TEXT, HARNESS_HOST_LABELS, HOST_LINKS_DIR, SKILLS_DIR, NO_HARNESS_DATA };

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
  const { Plugin, PluginSettingTab, Setting, Notice, Modal, ItemView, Platform, requestUrl, normalizePath } = obsidian;

  const VIEW_TYPE = 'icor-scaffold-dashboard';

  const DEFAULTS = {
    manifestUrl: DEFAULT_MANIFEST_URL,
    /* Where the latest myPKA manifest is published. Blank until myPKA has a
       public repository: blank means "not checked", and the plugin never
       guesses a URL. */
    mypkaManifestUrl: '',
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
    const self = {
      exists: (p) => adapter.exists(normalizePath(p)),
      read: (p) => adapter.read(normalizePath(p)),
      readBinary: (p) => adapter.readBinary(normalizePath(p)),
      write: (p, text) => adapter.write(normalizePath(p), text),
      /* `mkdir` of a folder that is already there throws on some adapters,
         so existence is checked first. One level at a time, because the
         adapter does not create parents (GL-1008: never assume the folder
         exists). */
      mkdir: async (p) => {
        const parts = normalizePath(p).split('/').filter(Boolean);
        let at = '';
        for (const part of parts) {
          at = at ? at + '/' + part : part;
          if (!(await adapter.exists(at))) await adapter.mkdir(at);
        }
      },
      /* `adapter.list` answers with paths already prefixed by the folder,
         so callers compare on the full path and never rejoin. */
      list: async (p) => {
        const dir = normalizePath(p);
        if (!(await adapter.exists(dir))) return { files: [], folders: [] };
        const r = await adapter.list(dir);
        return { files: (r && r.files) || [], folders: (r && r.folders) || [] };
      },
      listBases: async () => app.vault.getFiles().filter((f) => f.extension === 'base' && !f.path.startsWith(app.vault.configDir + '/')).map((f) => f.path),
      listScratchpads: async () => app.vault.getFiles().filter((f) => f.path.startsWith(SCRATCHPAD_ROOT + '/')).map((f) => f.path),
      listAgentContracts: async () => {
        const out = [];
        for (const folder of (await self.list(AGENTS_DIR)).folders) {
          const p = normalizePath(folder + '/AGENT.md');
          if (await adapter.exists(p)) out.push(p);
        }
        return out;
      },
      listShims: async () => (await self.list('.claude/agents')).files.filter((p) => p.endsWith('.md')).map((p) => normalizePath(p)),
      /* The canonical skills, by folder name. */
      listSkillNames: async () => (await self.list(SKILLS_DIR)).folders.map((p) => p.split('/').filter(Boolean).pop()).filter(Boolean),
      /*
       * The host link layer. Three answers, and the third one matters:
       *
       *   supported:false  the adapter could not list the folder here, so
       *                    nothing is claimed. There is no `lstat` in the
       *                    adapter on any platform, so a link can only ever
       *                    be judged by what is behind it, and where even
       *                    the listing fails the honest report is that this
       *                    was not checked rather than a finding invented
       *                    from an absence.
       *   present:false    the folder is not here. Normal: `.agents/` is a
       *                    dot-folder, Obsidian Sync never carries one, and
       *                    on a phone it will not exist at all.
       *   entries          one per link, with whether the skill behind it
       *                    is readable.
       */
      hostSkillLinks: async (names) => {
        /* A phone is answered before anything is read. Codex, Gemini CLI and
           Cursor do not run on iOS or Android, so nothing here is actionable
           there, and a sync tool that does carry dot folders (iCloud Drive,
           git, Dropbox, unlike Obsidian Sync which drops them) would
           otherwise hand a phone a list of links to repair on a device where
           the thing that reads them does not exist. */
        if (Platform && Platform.isMobile) return { supported: false, present: false, entries: [] };
        let there = false;
        try { there = await adapter.exists(normalizePath(HOST_LINKS_DIR)); } catch { return { supported: false, present: false, entries: [] }; }
        if (!there) return { supported: true, present: false, entries: [] };

        /* Every known skill is PROBED rather than read out of the listing,
           because `exists` follows the link and never throws, while the
           listing stats every entry and one dead entry ends it. The probe is
           also the honest test: what a host needs is the skill behind the
           link, not the link. */
        const entries = [];
        const seen = new Set();
        for (const name of names || []) {
          if (!name || seen.has(name)) continue;
          seen.add(name);
          let resolves = false;
          try { resolves = await adapter.exists(normalizePath(HOST_LINKS_DIR + '/' + name + '/SKILL.md')); } catch { resolves = false; }
          entries.push({ name, resolves, known: true });
        }

        /* The listing adds the links this vault no longer has a skill for.
           It is allowed to fail: on desktop a link with no target makes it
           reject, and `listable: false` carries that up as the finding it is
           rather than as an inability to look. */
        let listed = null;
        try { listed = await adapter.list(normalizePath(HOST_LINKS_DIR)); } catch { listed = null; }
        if (listed === null) return { supported: true, present: true, listable: false, entries };
        const paths = ((listed && listed.folders) || []).concat((listed && listed.files) || []);
        for (const raw of paths) {
          const name = String(raw).split('/').filter(Boolean).pop();
          if (!name || name.startsWith('.') || seen.has(name)) continue;
          seen.add(name);
          let resolves = false;
          try { resolves = await adapter.exists(normalizePath(HOST_LINKS_DIR + '/' + name + '/SKILL.md')); } catch { resolves = false; }
          entries.push({ name, resolves, known: false });
        }
        return { supported: true, present: true, listable: true, entries };
      },
    };
    return self;
  }

  class ScaffoldCheckPlugin extends Plugin {
    async onload() {
      this.settings = Object.assign({}, DEFAULTS, (await this.loadData()) || {});
      /* A hand-edited data.json cannot point outside the vault either. */
      this.settings.envFilePath = normalizeEnvFilePath(this.settings.envFilePath).path || DEFAULT_ENV_FILE;
      this.lastResult = null;
      this.lastQuality = null;
      this.lastHarness = null;
      this.store = new SecretStore(this.app.secretStorage);
      if (migrateToken(this.settings, this.store, this.backend())) await this.saveData(this.settings);

      this.statusEl = this.addStatusBarItem();
      this.statusEl.addClass('icor-scaffold-status');
      this.registerDomEvent(this.statusEl, 'click', () => this.showResult());
      this.paintStatus(this.settings.lastHealth || 'unknown');

      this.registerView(VIEW_TYPE, (leaf) => new DashboardView(leaf, this));
      this.addRibbonIcon('shield-check', 'Scaffold Check', () => this.run({ interactive: true }));
      this.addCommand({ id: 'run', name: 'Run the Scaffold Check', callback: () => this.run({ interactive: true }) });
      this.addCommand({ id: 'show', name: 'Show the last Scaffold Check result', callback: () => this.showResult() });
      this.addCommand({ id: 'dashboard', name: 'Open the Scaffold dashboard', callback: () => this.openDashboard() });
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

    /* Both version folders, `.icor-for-life/` and `.mypka/`, through the
       adapter: they are dot folders, which the file index never holds. */
    async readLocal() {
      const fs = vaultFs(this.app);
      return { fs, local: await engine.readLocalPairs(fs) };
    }

    /* One latest manifest. The token is sent only to a GitHub host
       (tokenAllowedFor), never to whatever host a URL setting names. */
    async fetchRemote(rawUrl) {
      const url = (rawUrl || '').trim();
      if (!url) throw new Error('no manifest URL is set');
      const headers = { Accept: 'application/json' };
      if (tokenAllowedFor(url)) {
        const token = await this.readToken();
        if (token) headers.Authorization = 'Bearer ' + token;
      }
      const resp = await requestUrl({ url, headers, throw: false });
      if (resp.status !== 200) throw new Error('HTTP ' + resp.status + ' fetching the latest manifest');
      if ((resp.text || '').length > 5e6) throw new Error('manifest too large');
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
      /* Two products, two fetches, one status each (0.7.0). A myPKA fetch
         that fails never turns the ICOR for Life result offline; the status
         bar shows the worse of the two. */
      let icorRemote = null, icorError = '', mypkaRemote = null, mypkaError = '';
      try { icorRemote = await this.fetchRemote(this.settings.manifestUrl); } catch (e) { icorError = e.message; }
      const mypkaUrl = (this.settings.mypkaManifestUrl || '').trim();
      if (mypkaUrl) { try { mypkaRemote = await this.fetchRemote(mypkaUrl); } catch (e) { mypkaError = e.message; } }
      if (!icorRemote && !mypkaRemote) {
        this.paintStatus('offline');
        this.settings.lastHealth = 'offline';
        await this.saveData(this.settings);
        if (interactive) new Notice('Scaffold Check: could not fetch the latest manifest (' + (icorError || mypkaError || 'no URL set') + '). Check the URLs and token in settings.');
        return null;
      }
      const { fs, local } = await this.readLocal();
      let result;
      try {
        result = await engine.runSuite({ fs, hash: sha256Hex, configDir: this.app.vault.configDir, local, icorRemote, icorError, mypkaRemote, mypkaError, mypkaUrlSet: !!mypkaUrl });
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

      /* The quality numbers are read here, outside the engine's gates: the
         script measures, this plugin shows. loadQuality never throws. */
      const quality = await engine.loadQuality(fs);
      this.lastQuality = quality;
      const harness = await engine.loadHarness(fs, { teamHere: result.mode.team });
      this.lastHarness = harness;

      if (this.settings.writeReport) {
        try { await this.writeReport(result, quality, harness); } catch (e) { if (interactive) new Notice('Scaffold Check: could not write the report (' + e.message + ')'); }
      }
      try { await this.appendHistory(result, quality); } catch (e) { if (interactive) new Notice('Scaffold Check: could not write the run history, so the dashboard trend misses this run.'); }
      this.refreshDashboard();
      if (interactive) this.showResult();
      else if (result.health === 'offline') new Notice('Scaffold Check: one latest manifest could not be read, so part of the check did not run. Click the status bar for the report.');
      else if (result.health !== 'ok') new Notice('Scaffold Check: ' + result.counts.broken + ' broken, ' + result.counts.attention + ' to do. Click the status bar for the report.');
      return result;
    }

    /* ---- the machine layer: quality.json (read) and history.json (ours) ---- */

    /* The quality file as parseQuality sees it. Read fresh every time: no
       vault event fires for a hidden folder (GL-1008). */
    readQuality() { return engine.loadQuality(vaultFs(this.app)); }
    /* The harness is the team's: in a vault without the team, it lives
       elsewhere and is not looked for. */
    async readHarness() {
      const fs = vaultFs(this.app);
      const teamHere = (await fs.exists('AGENTS.md')) && (await fs.exists(AGENTS_DIR));
      return engine.loadHarness(fs, { teamHere });
    }
    readHistory() { return engine.loadHistory(vaultFs(this.app)); }

    /* One record per completed run into this plugin's own subfolder of
       `.icor-for-life/`, created on first write; never a path outside it.
       Only when `.icor-for-life/` is already there (0.7.0): a myPKA team
       folder opened as a vault is not given an ICOR for Life marker. */
    async appendHistory(result, quality) {
      const fs = vaultFs(this.app);
      if (!(await engine.historyWritable(fs))) return;
      const next = engine.appendRun(await engine.loadHistory(fs), engine.runRecord(result, quality));
      await fs.mkdir(HISTORY_DIR);
      await fs.write(HISTORY_PATH, JSON.stringify(next, null, 2) + '\n');
    }

    /* ---- the dashboard ---- */

    async openDashboard() {
      const ws = this.app.workspace;
      const open = ws.getLeavesOfType(VIEW_TYPE);
      let leaf = open.length ? open[0] : null;
      if (!leaf) {
        leaf = ws.getLeaf(true);
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
      }
      ws.revealLeaf(leaf);
    }

    refreshDashboard() {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view && typeof leaf.view.render === 'function') leaf.view.render();
      }
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

    async writeReport(result, quality, harness) {
      const folder = normalizePath(this.settings.reportFolder || DEFAULT_REPORT_FOLDER);
      const fs = vaultFs(this.app);
      await fs.mkdir(folder);
      /* One reading of the clock for both the name and the contents: two
         readings can fall either side of a midnight and disagree. Re-running
         on the same day overwrites that day's note, which is what the
         setting promises. */
      const today = todayStr();
      const path = normalizePath(folder + '/' + today + '-scaffold-check.md');
      const text = engine.renderReport(result, { today, manifestUrl: this.settings.manifestUrl, mypkaManifestUrl: this.settings.mypkaManifestUrl, quality: quality || null, harness: harness || null });
      await fs.write(path, text);
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
      meta.setText(r.counts.broken + ' broken · ' + r.counts.attention + ' attention · ' + r.counts.info + ' info');
      /* One block per product, each with its own versions and findings. */
      const parts = r.suite
        ? [['icor', r.sections.icor], ['mypka', r.sections.mypka], ['pair', { title: 'Both together', status: '' }]]
        : [[null, { title: '', installedVersion: r.installedVersion, latestVersion: r.latestVersion }]];
      for (const [repo, s] of parts) {
        const mine = repo ? r.findings.filter((f) => f.repo === repo) : r.findings;
        if (repo === 'pair' && !mine.length) continue;
        if (s.title) c.createEl('h3', { text: s.title });
        if (repo !== 'pair') c.createEl('p', { cls: 'icor-scaffold-meta', text: 'Installed ' + (s.installedVersion || 'unknown') + ' · latest ' + (s.latestVersion || 'unknown') });
        for (const sev of ['broken', 'attention', 'info']) {
          const rows = mine.filter((f) => f.severity === sev);
          if (!rows.length) continue;
          c.createEl('h4', { text: sev[0].toUpperCase() + sev.slice(1) + ' (' + rows.length + ')' });
          const ul = c.createEl('ul');
          for (const f of rows.slice(0, 40)) {
            const li = ul.createEl('li');
            li.createEl('code', { text: f.path });
            li.createSpan({ text: ' ' + f.message });
          }
          if (rows.length > 40) c.createEl('p', { text: (rows.length - 40) + ' more in the report.' });
        }
      }
      const q = this.plugin.lastQuality;
      const qp = c.createEl('p', { cls: 'icor-scaffold-meta' });
      qp.setText(q && q.status === 'ok' ? QUALITY_TEXT[q.health] + (q.stale ? ' (stale)' : '') + ' · ' + q.findings.length + ' findings in the report' : QUALITY_TEXT.unknown);
      const foot = c.createDiv({ cls: 'icor-scaffold-foot' });
      if (this.plugin.lastReportPath) {
        const b = foot.createEl('button', { text: 'Open the report' });
        b.addEventListener('click', () => { this.app.workspace.openLinkText(this.plugin.lastReportPath, '', true); this.close(); });
      }
      const dash = foot.createEl('button', { text: 'Open the dashboard' });
      dash.addEventListener('click', () => { this.close(); this.plugin.openDashboard(); });
      const again = foot.createEl('button', { text: 'Run again' });
      again.addEventListener('click', () => { this.close(); this.plugin.run({ interactive: true }); });
    }
    onClose() { this.contentEl.empty(); }
  }

  /* The dashboard: one ItemView that renders from the JSON on disk (the
     quality file the script writes, the history file this plugin writes)
     and from the last result in memory. Everything is text with a colour
     beside it, never a colour alone, and nothing needs a hover: the same
     view on a phone. No library, no network, no chart runtime; the trend
     is one inline SVG path per metric. */
  class DashboardView extends ItemView {
    constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return 'Scaffold dashboard'; }
    getIcon() { return 'shield-check'; }
    async onOpen() { await this.render(); }
    async onClose() { this.contentEl.empty(); }

    async render() {
      const plugin = this.plugin;
      const s = plugin.settings;
      let quality, history, harness;
      try { quality = await plugin.readQuality(); } catch (e) { quality = engine.parseQuality(null); }
      try { history = await plugin.readHistory(); } catch (e) { history = engine.parseHistory(null); }
      try { harness = await plugin.readHarness(); } catch { harness = engine.parseHarness(null); }
      const c = this.contentEl;
      c.empty();
      c.addClass('icor-scaffold-dashboard');
      c.createEl('h2', { text: 'Scaffold dashboard' });

      /* header: the two healths side by side */
      const tiles = c.createDiv({ cls: 'icor-scaffold-tiles' });
      const r = plugin.lastResult;
      const scaffoldHealth = r ? r.health : (s.lastHealth || 'unknown');
      const t1 = tiles.createDiv({ cls: 'icor-scaffold-tile' });
      t1.createDiv({ cls: 'icor-scaffold-tile-label', text: 'Scaffold' });
      const h1 = t1.createDiv({ cls: 'icor-scaffold-head' });
      h1.createSpan({ cls: 'icor-scaffold-dot icor-scaffold-dot-' + scaffoldHealth, attr: { 'aria-hidden': 'true' } });
      h1.createSpan({ text: STATUS_TEXT[scaffoldHealth] || STATUS_TEXT.unknown });
      t1.createDiv({ cls: 'icor-scaffold-meta', text: r
        ? r.counts.broken + ' broken · ' + r.counts.attention + ' attention · ' + r.counts.info + ' info · ICOR for Life ' + (r.installedVersion || 'unknown') + ', latest ' + (r.latestVersion || 'unknown')
          + (r.suite ? ' · myPKA ' + (r.mypkaInstalledVersion || 'unknown') + ', latest ' + (r.mypkaLatestVersion || 'unknown') : '')
        : (s.lastRun ? 'Last run ' + (localDayOfIso(s.lastRun) || s.lastRun) + '. Run the check for the details.' : 'Not run yet.') });

      const qh = quality.status === 'ok' ? quality.health : 'unknown';
      const t2 = tiles.createDiv({ cls: 'icor-scaffold-tile' });
      t2.createDiv({ cls: 'icor-scaffold-tile-label', text: 'Knowledge quality' });
      const h2 = t2.createDiv({ cls: 'icor-scaffold-head' });
      h2.createSpan({ cls: 'icor-scaffold-dot icor-scaffold-dot-' + qh, attr: { 'aria-hidden': 'true' } });
      h2.createSpan({ text: QUALITY_TEXT[qh] || QUALITY_TEXT.unknown });
      if (quality.stale) h2.createSpan({ cls: 'icor-scaffold-stale', text: 'stale' });
      t2.createDiv({ cls: 'icor-scaffold-meta', text: quality.status === 'ok'
        ? 'Measured ' + (quality.generated || 'at an unknown time') + (quality.ageDays !== null ? ' (' + quality.ageDays + ' days ago)' : '') + (quality.scaffoldVersion ? ' · scaffold ' + quality.scaffoldVersion : '') + ' · ' + quality.findings.length + ' findings'
        : 'Nothing measured yet.' });

      const hh = harness.status === 'ok' ? harness.health : harness.status === 'elsewhere' ? 'elsewhere' : 'unknown';
      const t3 = tiles.createDiv({ cls: 'icor-scaffold-tile' });
      t3.createDiv({ cls: 'icor-scaffold-tile-label', text: 'Harness' });
      const h3 = t3.createDiv({ cls: 'icor-scaffold-head' });
      h3.createSpan({ cls: 'icor-scaffold-dot icor-scaffold-dot-' + (hh === 'elsewhere' ? 'unknown' : hh), attr: { 'aria-hidden': 'true' } });
      h3.createSpan({ text: HARNESS_TEXT[hh] || HARNESS_TEXT.unknown });
      t3.createDiv({ cls: 'icor-scaffold-meta', text: harness.status === 'ok'
        ? harness.hosts.filter((x) => x.detected.length).length + ' of ' + harness.hosts.length + ' hosts detected'
          + (harness.skills && harness.skills.count !== null ? ' · ' + harness.skills.count + ' skills' : '')
          + (harness.tests ? ' · guards ' + (HARNESS_TESTED_TEXT[harness.tests.status] || harness.tests.status) : '')
          + (harness.generated ? ' · ' + harness.generated : '')
        : hh === 'elsewhere' ? 'The team lives in its own folder.' : 'Nothing looked at yet.' });

      /* no data, or data this plugin cannot read: the one sentence */
      if (harness.status !== 'ok') {
        c.createEl('p', { cls: 'icor-scaffold-notice', text: harness.message });
      }
      if (quality.status !== 'ok') {
        c.createEl('p', { cls: 'icor-scaffold-notice', text: quality.message });
      }

      /* the counts row */
      const countKeys = Object.keys(quality.counts);
      if (countKeys.length) {
        const row = c.createDiv({ cls: 'icor-scaffold-counts' });
        const ordered = Object.keys(QUALITY_COUNT_LABELS).filter((k) => k in quality.counts).concat(countKeys.filter((k) => !(k in QUALITY_COUNT_LABELS)));
        for (const k of ordered) {
          const chip = row.createSpan({ cls: 'icor-scaffold-chip' });
          chip.createSpan({ cls: 'icor-scaffold-chip-n', text: String(quality.counts[k]) });
          chip.createSpan({ text: ' ' + (QUALITY_COUNT_LABELS[k] || k) });
        }
      }

      /* the metric table with a trend per row */
      const metrics = engine.orderedMetrics(quality);
      if (metrics.length) {
        const wrap = c.createDiv({ cls: 'icor-scaffold-tablewrap' });
        const table = wrap.createEl('table', { cls: 'icor-scaffold-metrics' });
        const hr = table.createEl('thead').createEl('tr');
        for (const h of ['Metric', 'Value', 'Severity', 'Trend']) hr.createEl('th', { text: h });
        const body = table.createEl('tbody');
        for (const m of metrics) {
          const tr = body.createEl('tr', { cls: 'icor-scaffold-sev-' + m.severity });
          tr.createEl('td', { text: m.label });
          tr.createEl('td', { cls: 'icor-scaffold-num', text: engine.metricValueText(m) });
          const sev = tr.createEl('td', { cls: 'icor-scaffold-sevcell' });
          sev.createSpan({ cls: 'icor-scaffold-dot icor-scaffold-dot-' + m.severity, attr: { 'aria-hidden': 'true' } });
          sev.createSpan({ text: m.severity });
          const trend = tr.createEl('td', { cls: 'icor-scaffold-trend' });
          const series = engine.metricSeries(history, m.id, 30);
          if (series.length >= 2) {
            const label = 'Last ' + series.length + ' runs, from ' + series[0] + ' to ' + series[series.length - 1];
            const svg = trend.createSvg('svg', { cls: 'icor-scaffold-spark', attr: { viewBox: '0 0 60 16', width: '60', height: '16', role: 'img', 'aria-label': label } });
            svg.createSvg('title').textContent = label;
            svg.createSvg('path', { attr: { d: engine.sparklinePath(series, 60, 16), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' } });
            trend.createSpan({ cls: 'icor-scaffold-trend-text', text: ' ' + series[0] + ' to ' + series[series.length - 1] });
          } else {
            trend.createSpan({ cls: 'icor-scaffold-meta', text: series.length === 1 ? 'one run' : 'no runs yet' });
          }
        }
      }

      /* the hosts, one row each: what a person checks before blaming the AI */
      if (harness.status === 'ok' && harness.hosts.length) {
        c.createEl('h3', { text: 'Hosts' });
        const hwrap = c.createDiv({ cls: 'icor-scaffold-tablewrap' });
        const htable = hwrap.createEl('table', { cls: 'icor-scaffold-metrics' });
        const hhr = htable.createEl('thead').createEl('tr');
        for (const h of ['Host', 'Detected', 'Installed', 'Trusted', 'Guards', 'Unsupported']) hhr.createEl('th', { text: h });
        const hbody = htable.createEl('tbody');
        for (const x of harness.hosts) {
          const tr = hbody.createEl('tr');
          tr.createEl('td', { text: x.label });
          tr.createEl('td', { text: x.detected.length ? x.detected.join(', ') : 'no' });
          tr.createEl('td', { text: x.installed || 'nothing' });
          tr.createEl('td', { text: HARNESS_TRUSTED_TEXT[x.trusted] || x.trusted });
          tr.createEl('td', { text: HARNESS_TESTED_TEXT[x.tested] || x.tested });
          tr.createEl('td', { text: x.unsupported.length ? x.unsupported.join('; ') : 'nothing' });
        }
        for (const x of harness.hosts) {
          if (x.trusted === 'no' && x.trustedNote) c.createEl('p', { cls: 'icor-scaffold-notice', text: x.label + ', trust: ' + x.trustedNote });
          if (x.sandbox && x.sandboxNote) c.createEl('p', { cls: 'icor-scaffold-meta', text: x.label + ', sandbox: ' + x.sandboxNote });
        }
        for (const pr of harness.problems) c.createEl('p', { cls: 'icor-scaffold-notice', text: pr });
      }

      const runs = history.runs.length;
      c.createEl('p', { cls: 'icor-scaffold-meta', text: runs ? runs + ' run' + (runs === 1 ? '' : 's') + ' recorded, the last ' + Math.min(runs, 30) + ' drawn.' : 'No runs recorded yet; the trend fills in from the next check.' });

      const foot = c.createDiv({ cls: 'icor-scaffold-foot' });
      const runBtn = foot.createEl('button', { text: 'Run the check' });
      runBtn.addEventListener('click', () => plugin.run({ interactive: true }));
      if (plugin.lastReportPath) {
        const b = foot.createEl('button', { text: 'Open the report' });
        b.addEventListener('click', () => plugin.app.workspace.openLinkText(plugin.lastReportPath, '', true));
      }
      const again = foot.createEl('button', { text: 'Refresh' });
      again.addEventListener('click', () => this.render());
    }
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
      c.createEl('p', { text: 'Read-only. Compares this vault with the latest ICOR for Life scaffold and, where the AI team is in this vault, the latest myPKA, and writes a report. It never changes a scaffold file.' });
      const s = this.plugin.settings;
      const plugin = this.plugin;
      const save = () => plugin.saveData(s);
      const storeOk = plugin.store.available();
      const backend = plugin.backend();
      const label = BACKEND_LABEL[backend];

      new Setting(c).setName('Latest ICOR for Life manifest URL')
        .setDesc('Where the latest ICOR for Life Scaffold\'s .icor-for-life/manifest.json is published. A raw file URL or a GitHub contents API URL.')
        .addText((t) => t.setValue(s.manifestUrl).setPlaceholder(DEFAULT_MANIFEST_URL).onChange(async (v) => { s.manifestUrl = v.trim(); await save(); }));

      new Setting(c).setName('Latest myPKA manifest URL')
        .setDesc('Where the latest myPKA release\'s .mypka/manifest.json is published. Blank means the team side is not checked; this plugin never guesses a URL. Fetched only when set, as a second request next to the one above.')
        .addText((t) => t.setValue(s.mypkaManifestUrl || '').setPlaceholder('https://raw.githubusercontent.com/<owner>/<repo>/main/.mypka/manifest.json').onChange(async (v) => { s.mypkaManifestUrl = v.trim(); await save(); }));

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
        .setDesc('Only needed when a manifest URL is on a private repository. Saved to ' + label + ', sent only to GitHub (github.com, api.github.com, raw.githubusercontent.com) and never to any other host, never written anywhere else. The field is cleared once the token is saved; the line below says where it is.')
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
      if (s.lastRun) c.createEl('p', { cls: 'icor-scaffold-meta', text: 'Last run ' + (localDayOfIso(s.lastRun) || s.lastRun) + ' · ' + (STATUS_TEXT[s.lastHealth] || '') });
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
