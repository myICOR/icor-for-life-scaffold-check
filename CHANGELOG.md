# Changelog

All notable changes to ICOR for Life - Scaffold Check.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

## [0.8.1] - 2026-09-26

### Fixed
- **An untouched copy older than the version you installed is not yours.**
  A removed or renamed file was matched against the last version the
  Scaffold shipped and the version your vault installed, so a copy older
  than both was called "yours, keep it". The check now also reads
  `previous_removed`, the list of every older version of a removed file
  that the ICOR for Life Scaffold manifest carries from its next release,
  and reports such a copy as a leftover you can delete. The same holds for
  a file the Scaffold still ships: a copy that is neither the version you
  installed nor the latest, but one a release shipped, is reported as an
  older shipped version that is safe to update, not as your edit. A copy
  you edited is still yours. With an older manifest nothing changes.
  Thanks to Brian Carroll (@brijcarroll) for the idea (item E, #7).

## [0.8.0] - 2026-09-26

### Added
- **A setting for files you left out on purpose.** "Left out on purpose"
  takes vault-relative paths, one per line, from ICOR for Life or from
  myPKA. While a listed file is missing, the report lists it as info,
  left out, instead of as something to do. If the file comes back, it is
  checked as usual. The list is empty by default, so nothing changes until
  you fill it. A path pasted with backslashes, as on Windows, matches too.
  Thanks to @agilley7 for the setting (#6, closes #5).

### Fixed
- **A journal placeholder is not reported missing beside real entries.**
  Every shipped agent carries one placeholder entry in its `Journal/`
  folder only to keep the folder in place. When that placeholder is
  missing but the folder holds entries of the agent's own, it is no longer
  reported as a missing canonical file. To tell, the check lists the file
  names in that one folder; it opens none of them (`SECURITY.md`, Reads).
  An empty folder, or no folder, is still reported. Thanks to @agilley7
  for the fix (#6, closes #5).
- **A renamed shipped agent's companion files are not reported missing.**
  When a shipped agent lives under a folder name of your own, the other
  files of its shipped folder and its avatar are skipped by the
  missing-file check, as its contract and shim already were. Thanks to
  Mohammad Yama Azimi (@myamaazimi) for the fix (#4, closes #3).
- **An untouched copy of the version you installed is a leftover, not
  yours.** A removed or renamed file was matched only against the last
  version the Scaffold shipped, so an untouched copy from an older install
  was called "yours, keep it". It now also matches the version your vault
  installed, and is reported as a leftover you can delete. A copy you
  edited is still yours. Thanks to Brian Carroll (@brijcarroll) for the
  fix (#8, closes #7).
- **A header quoted inside a script is not a header.** A script that
  builds a generated-file header from a format string was reported as a
  generated file that lost its hash, with a fix that could not clear it.
  The header is now read only where the generator writes it: the first
  non-blank line, after the frontmatter. Thanks to @pk-smithb for the fix
  (#10, closes #9).

## [0.7.1] - 2026-09-26

### Changed
- **An empty "Latest ICOR for Life manifest URL" now means the default.**
  Clearing the field used to switch the check off ("no check"); it now
  reads the default URL the field shows as its placeholder.

### Fixed
- **The check reads the ICOR for Life manifest from its new home.** The
  Scaffold repository moved from `TomSolid` to `myICOR` on 2026-09-26. The
  default manifest URL now names `myICOR/icor-for-life-scaffold`, and a
  saved setting that is exactly the old default is moved to the new one
  once, on load. A URL you typed yourself is never changed. GitHub still
  redirects the old address, so 0.7.0 keeps working meanwhile.
- **Monospace text follows your Obsidian font.** Without the INKLINE theme,
  the report and dashboard used a hard-coded font stack; they now fall back
  to Obsidian's own monospace setting.

### Security
- **Release assets carry a build-provenance attestation.** `main.js`,
  `manifest.json` and `styles.css` are attested by the release workflow.
  Check a download with
  `gh attestation verify main.js --repo myICOR/icor-for-life-scaffold-check --signer-workflow myICOR/.github/.github/workflows/obsidian-release.yml`
  (the same for `manifest.json` and `styles.css`).

## [0.7.0] - 2026-09-25

Reads the split: ICOR for Life Scaffold 2.0.0 (content, `.icor-for-life/`)
and myPKA 6.0.0 (the AI team, `.mypka/`). Must be live before the Scaffold's
2.0.0 reaches `main`: 0.6.0 cannot read the new manifest shape and shows
"Scaffold: offline" (nothing is deleted).

### Fixed
- **A team file that moved to myPKA is never reported as a leftover.** At
  2.0.0 the Scaffold's history lists every team file it no longer ships as
  removed, with the old hashes, so an untouched `AGENTS.md` or agent
  contract matched and would have read "Delete it". A path the myPKA
  manifest ships, or that the Scaffold's history marks `moved_to: mypka`,
  is now a move, judged in the myPKA section. Only a path in neither
  product is a leftover (at 2.0.0: `CLAUDE.md`, `GEMINI.md` and one
  maintainer script). Without the myPKA manifest, a 2.0.0 removal that does
  not say where it went is not judged, and one line says why.
- Both manifest shapes are read: the list of 1.x and the map of 2.0.0, under
  schema 1 or 2. 0.6.0 threw "not a scaffold manifest" on the new one, and
  crashed on a local manifest in the new shape.
- "Canonical undefined is missing" now names the kind ("Canonical guideline
  is missing"), with the builder's own rules.
- Example notes are known from the manifest's `examples` list (schema 2),
  or from the per-file flags of a 1.x manifest.
- `2.0.0-lab` sorts below `2.0.0`, as the builders sort.

### Added
- **Mode detection.** Content and team in one vault, content only (mode B:
  "the myPKA team is not in this vault ... nothing is missing here"), or a
  team folder opened as a vault ("the content lives elsewhere").
- **Two sections in the report**, ICOR for Life (content) and myPKA (team),
  each with its versions and findings; new report keys `mode`,
  `mypka_installed_version`, `mypka_latest_version`.
- **A second setting, "Latest myPKA manifest URL"**, blank by default. A
  failed myPKA fetch never turns the ICOR for Life result offline; the status
  bar shows the worse of the two.
- **The installed pair.** myPKA's `requires` against ICOR for Life's
  `implements`: out of range is broken ("session start will refuse"); a newer
  ICOR for Life outside your myPKA's range says to update myPKA first.
- Agent identities are read from the myPKA manifest.
- An `.update` file the updater left beside an edited file is one "waiting
  for your merge" item.
- Without an installed manifest, the release's `previous` hashes tell an
  older shipped copy (safe to update) from your edit.
- On a device without dot folders (Obsidian Sync), one line per product
  instead of a missing file per path.

### Changed
- The harness is read from `.mypka/state/harness.json` first, then from the
  old `.icor-for-life/scripts/harness.json`, labelled as the old location. In
  a vault without the team it says the team lives elsewhere.
- The GitHub token is sent only to GitHub hosts, never to another host a URL
  setting names.
- Seed files (`.obsidian/workspace.json`, `.mcp.json`) are reported only when
  missing, never as changed. The version folders' own `VERSION`,
  `CHANGELOG.md` and `README.md` are no longer compared file by file.
- The run history is written only where `.icor-for-life/` already exists, and
  records each product separately.
- `GEMINI.md` is no longer treated as a generated file.

## [0.6.0] - 2026-09-21

### Changed
- Relicensed under MIT. Releases before 0.6.0 remain under the ICOR for Life
  Source-Available License (Code) v1.0.
- Release workflow: the guard job's checkout pinned to a commit SHA.

## [0.5.1] - 2026-09-15

### Fixed
- **The report note is now dated by the day on your own clock, not by the
  day it is in Greenwich.** West of UTC an evening run wrote tomorrow's
  date onto today's findings; east of UTC an early-morning run wrote
  yesterday's and overwrote the note already there. The filename, the
  note's `date` field and its heading now all come from one reading of
  your clock, and the dashboard's and the settings tab's Last run read the
  same way. Running twice in one day still overwrites that day's note, as
  the setting says it does.

  Reported by Brian Carroll in the bug reports channel.
- **The settings tab dates the last run by your day, not by UTC.** It
  printed the stored ISO instant raw and disagreed with the dashboard tile
  two rows away.

## [0.5.0] - 2026-09-14

### Added
- **The Daily Scratchpad keeps its shape.** A ninth check reads every file in
  `00 Daily Scratchpad/` and points at the ones that are not where `GL-1004`
  says they go: a capture loose at the room root, a capture nested only by
  year, a note named for its subject rather than its date, and a saved view
  buried inside a dated folder. One finding per file, because the fix is per
  file. Each finding says what to do, and the two that have a cause worth
  naming say the cause: the nesting one names the Daily notes and Scratchpad
  settings that put the file there, and the title-named one names the
  `[[wikilink]]` click that creates these by accident together with the
  Default location for new notes setting behind it.

  The shapes that pass are the ones the real tools produce: `YYYY-MM-DD.md`
  from Obsidian's Daily notes plugin, `YYYYMMDDHHmm.md` from the Scratchpad
  plugin with an optional ` - Title` added afterwards and Obsidian's ` 2` on a
  same-minute collision, `Untitled.md` before a subject note is named, and
  `YYYY-MM-DD_canvas.canvas` however you title or number it. The two legacy
  timestamp shapes stay legal so an older vault is not called broken for its
  history.

  Gated in `test/engine.test.mjs`: four red cases, one green case that carries
  every legal shape so the check cannot be satisfied by an empty room, and one
  test that judges the matcher on its own. Removing the check turns four of
  them red, which is how the gates were verified rather than assumed.

- **The generated harness layer is read as generated, not as your editing.**
  ICOR for Life Scaffold 1.23.0 stopped shipping its AI-host bindings typed by
  hand and started generating them: `Scripts/scaffold-init.py apply` writes the
  skills, the Codex and Gemini agent shims, the hook configs and the host
  pointers from your vault's own frontmatter. Two vaults on the same scaffold
  version therefore hold different bytes in those files on purpose, and the
  three-way file check called every one of them "you edited this file" on any
  vault that had hired a single agent.

  Every generated file opens with a header naming its source and carrying a
  content hash. That header, never a path list, is what makes a file generated
  here, so the generator can change what it owns without this plugin learning
  about it. The hash is recomputed the way `scaffold-init.py check` does it,
  including the JSON case where the header lives in a value because JSON cannot
  carry a comment. Intact means the file differs from the scaffold only because
  your source does, and there is nothing to do. A mismatch means it was edited
  by hand, and that is the finding, because the next apply overwrites the edit
  without saying so. The fix line always names the generator and the source to
  put the change in, never a hand edit and never a copy from the scaffold.

  The `.claude/agents/*.md` shims are deliberately left out of this: the
  generator classifies them as held by hand, because they carry instructions the
  contract does not, so copying the shipped shim back in is still the right fix
  for them. `.claude/settings.json` is its own case again, since the generator
  owns one key in it and you own the rest.

- **`.agents/skills/` is checked as what it is: per device.** The links Codex,
  Gemini CLI and Cursor read are written by the generator, never tracked and
  never shipped. Absent is not a finding, it means this device has not run the
  generator. A link with no skill behind it IS a finding, because the host
  follows it, finds nothing and reports nothing. The test is whether the skill
  behind the link is readable rather than anything about symlinks, since the
  vault adapter has no `lstat` on any platform; where the adapter cannot list
  the folder the report says it was not checked here and claims nothing either
  way.

- **The Harness block.** `scaffold-init.py doctor --json` writes what it found
  about each AI host to `.icor-for-life/scripts/harness.json`, schema 1, and
  this plugin reads that one file and shows it in the report and on the
  dashboard: per host what is detected, what is installed, whether the host
  trusts this folder, whether the guards have been watched go red, and what
  that host cannot do at all. A host with no hook system reads as not
  applicable rather than as untested, and a skipped red test is shown, because
  a skip is not a pass. No file yet is one sentence carrying the command, never
  an error. The generator looks; this plugin only reads.

### Changed
- **Three groups of findings are headed with words rather than with their
  machine name**: "Generated harness layer", "Host skill links" and "Daily
  Scratchpad". A kind the report has no label for still uses its own name, as
  every kind did before these three arrived.

- **Nothing under `.icor-for-life/scripts/` is ever reported as drift.** The
  per-session receipts `checkpoint.py` writes, `session.json`, `harness.json`
  and this plugin's own run history are state, not sources (GL-1008's
  membership test: a file belongs there only if something regenerates it).
  `.icor-for-life/VERSION`, which does ship, is still read.

- **Flint's review, three conditions, landed before release.** A dangling link
  does not appear in a desktop listing, it ends the listing: the adapter stats
  every entry and a link with no target throws, so the one input this check
  exists to catch was the one input that turned it into an Info line saying
  nothing could be looked at. A rejected listing is now the finding. Line
  endings are normalised before any hash, because the generator writes
  `os.linesep` on Windows and reads back under universal newlines, so without
  this every generated file on Windows would read as hand-edited forever and
  the fix it printed would rewrite the same bytes. And a phone is answered
  before anything is read, since Codex, Gemini CLI and Cursor do not run
  there, so the report says which rather than blaming the adapter.

- **Whether Codex trusts this folder's hooks, in words.** Scaffold 1.23.0's
  `doctor --json` now reads Codex's own config and says yes, NOT TRUSTED or
  unknown, and the Harness block shows the word in the table with the sentence
  that says what to do under it. This is worth a line of its own because the
  failure it uncovers is silent by design: `codex exec` never asks about hooks
  and runs none it has not been told to trust, without printing anything, so a
  member with untrusted hooks has every guard off and a terminal that looks
  exactly like one where they are on. A host that is not trusted lifts the
  Harness health, so the heading can never read ok above that line. An
  unreadable config reads unknown and never no: telling somebody their guards
  are off because a file could not be opened sends them to fix something that
  may not be broken. Codex's sandbox note travels in the same file and is
  shown for the host that has one.

- Gated in `test/engine.test.mjs`: 31 new cases for the harness work, 37 in this release, 49 to 86 in the file and 118 across the suite. The hash fixtures are real
  1.23.0 generator output rather than this plugin's idea of it, one copied
  byte for byte and one hashed by the generator's own arithmetic, because a
  test that builds its input with the code under test proves only that the
  code agrees with itself. Twenty gates were each watched go red by
  removing the code behind them before any of it was trusted, and one of
  them was rewritten because the first version stayed green with the code
  removed.

### Known

- Seven `addEventListener` calls remain where the plugin guideline prefers
  `registerDomEvent`. The one that was a clean win, the status bar item
  registered once in `onload`, is changed. The other six are not, on purpose:
  three are in a `Modal` and a `PluginSettingTab`, neither of which is a
  `Component`, so the only `registerDomEvent` available belongs to the plugin
  and would hold every handler until unload, which for a modal opened
  repeatedly is a leak rather than a fix. The other three are in a view that
  re-renders on a button press and `empty()`s its own container each time, so
  registering them on the view would accumulate handlers per render while the
  nodes they point at are already gone. In every one of the six the listener
  dies with the node. Revisit if any of those containers stops being emptied.

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
