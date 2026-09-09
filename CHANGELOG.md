# Changelog

All notable changes to ICOR for Life - Scaffold Check.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-09-09

### Added
- **Knowledge quality.** The check now shows how healthy the knowledge base
  itself is, not only whether the scaffold's files are intact. The numbers
  are measured by the scaffold's own `Scripts/check-quality.py --write`,
  which ships with ICOR for Life Scaffold 1.18.0 and writes them to
  `.icor-for-life/scripts/quality.json` (schema 1). This plugin never
  measures: it reads that one file and shows it. Thirteen
  metrics, from notes without a link and invented frontmatter fields to
  orphans, dangling links and captures left sitting in the inbox.
- **The report gains a "Knowledge quality" section**, between the severity
  groups and "For your AI": the health in the heading, a metric table
  (label, value, severity as text), the entity counts, and the findings
  grouped under their metric, twenty per metric with a "+n more" line.
  Each finding names the file, says what was found and says what to do.
  Frontmatter gains `quality_health`, `quality_generated`, `quality_stale`
  and one key per metric id, so a Base or a script can read the numbers
  without opening the JSON. The "For your AI" prompt now ends by pointing
  the AI at the quality section and SOP-1014, propose first, apply only
  after you say yes.
- **A dashboard.** A new view, "Open the Scaffold dashboard" in the command
  palette and a button in the result window: both healths side by side, the
  entity counts, and the metric table with a trend line per metric drawn
  from the last thirty runs. The trend is one inline SVG path, no chart
  library and no network. Severity is always a word beside the colour, the
  table scrolls sideways inside its own box, and nothing needs a hover, so
  the same view reads on a phone.
- **Run history** at `.icor-for-life/icor-for-life-scaffold-check/history.json`
  (schema 1), one record per completed run, capped at the last ninety. It is
  state rather than a setting, so it lives in the machine layer and not in
  `data.json`; it is regenerable and per device, and a missing or malformed
  one starts fresh rather than failing.
- `test/engine.test.mjs`: 13 gates for the quality reader and its two
  renderers (with data, with none, with the wrong schema, with numbers gone
  stale), the report frontmatter keys, and the run history (append, the
  ninety cap, malformed recovery, the sparkline geometry). Each was watched
  going red against a mutated copy of `main.js` before it was trusted.

### Changed
- No quality file yet is one sentence, in the report and on the dashboard,
  saying how to get one: run `Scripts/check-quality.py --write` (ICOR for
  Life Scaffold 1.18.0 or later) in the ICOR for Life Terminal, or ask your
  AI to check your notes. A file carrying another schema is refused with one
  sentence naming the schema seen and the one expected; a file that is not
  valid JSON is refused the same way. None of them is an error, and none can
  stop a check.
- Numbers older than seven days are shown with a stale marker and their age.
- A metric value of one reads with a singular unit ("1 day", not "1 days").
  The script writes units in the plural; how a number reads is the plugin's
  job.
- `vaultFs` gained `write`, `mkdir` and `list`, so every read and write goes
  through the one adapter wrapper instead of reaching for the adapter inline.
  `mkdir` creates one level at a time and checks existence first, since the
  hidden folder is not carried by Obsidian Sync and may not exist on a
  second device.

## [0.3.0] - 2026-09-08

### Changed
- Keys move to Obsidian secret storage. The GitHub token no longer lives in
  `data.json`. A new setting, "Where your keys live", picks one of two
  backends: Obsidian's keychain (Settings, General, Keychain; the default
  on Obsidian 1.11.4 and newer, id `icor-for-life-scaffold-check-github-token`)
  or a KEY=value env file in the vault (`06 AI Team/AI Team Knowledge/.env`
  by default, key `GITHUB_TOKEN`; the only choice on an older Obsidian,
  where the dropdown is disabled). Only the selected backend is read; there
  is no fallback to the other one, since a fallback would hide a
  misconfiguration.
- On first load in keychain mode a token still in `data.json` is moved into
  the keychain and the field is blanked. Nothing is ever moved the other
  way on its own: the settings tab shows where a token is right now (the
  keychain, the env file, still in `data.json`) with a "Move to ..." button
  per place, and a Remove button for the backend in use.
- The token field is a password input that is cleared once the token is
  saved. No value is shown, echoed in a notice, or logged, not even masked;
  a gate in the test suite fails on any `console` call in the source.
- Saving in env-file mode rewrites (or appends) that one `GITHUB_TOKEN=`
  line and leaves every other byte of the file as it was, including a last
  line without a terminator, CRLF endings, comments, and blank lines.

### Added
- `test/secrets.test.mjs`: 28 gates for the env-file reader and writer
  (byte-identical rest of file, idempotent, comment lines untouched), the
  backend choice, the keychain wrapper, and the migration against a 0.2.0
  `data.json` fixture. Red cases first, and each new gate was watched
  going red against a mutated copy of `main.js` before it was trusted.
- README: "Where your keys live", and the two disclosures the Obsidian
  developer policies ask for (account, network use).

## [0.2.0] - 2026-09-07

### Added
- Agent identity. Every agent contract in the vault
  (`06 AI Team/Agents/<Name>/AGENT.md`) is checked for its `myicor_id`:
  missing, malformed (not a lowercase UUID v4), the nil placeholder on a
  contract that is not a template, or one id shared by two contracts
  (broken, naming both). Templates are the nil placeholder plus a name
  that starts with `Agent ` or `_`.
- Shipped agents are found by id, from the manifest's new `agents` key
  (scaffold 1.11.1). An agent you renamed is reported as intact under
  your name, and neither its canonical contract nor its shim is reported
  missing. A shipped agent whose canonical contract carries no id, or a
  different id, is named with the fix. Nothing carrying the id at all is
  the missing-file finding it always was.
- A new `agents` group in the report, counted like the others. The prompt
  for your AI gains one rule: never change or reuse a `myicor_id`.
- A manifest without `agents` (1.11.0 and older) still works: the local
  checks run, identity matching is skipped, and one info line says the
  manifest predates agent identities.
- 18 new gates, red first, with the shipped agents' real ids as fixtures.

### Changed
- The config folder is no longer assumed to be `.obsidian`: the plugin
  passes the vault's own `configDir`, so a device on a config-folder
  profile (`.obsidian-mobile`) is checked against the folder it uses.
- The settings tab no longer opens with a heading carrying the plugin
  name (Obsidian plugin guideline; scanner rule
  `settings-tab/no-manual-html-headings`).
- `SECURITY.md` and the README disclose the two new reads (agent
  contracts and, in the renamed-agent case, the `.claude/agents` shims),
  and that a vault received through Obsidian Sync has no hidden folders
  except `.obsidian`.

## [0.1.0] - 2026-09-01

### Added
- First release. Read-only check of a vault against the latest ICOR for
  Life Scaffold: the version gap; canonical files as missing, changed
  upstream, or edited by you; leftovers the scaffold removed after your
  version, matched by content, with the changelog line that explains
  each; the rooms, the expected plugins, every Base's target folder,
  every enabled snippet's file. One report note, grouped by kind. The
  engine is pure and exported for `node --test`.
