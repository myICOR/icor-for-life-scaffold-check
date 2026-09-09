# ICOR for Life - Scaffold Check

Is your vault up to date with the ICOR for Life Scaffold, and is what it has
still intact? This plugin compares your vault with the latest scaffold
version, read-only, and writes a report you can work through by hand or hand
to your AI.

**Beta release.** It works and is in daily use in a real vault, but you will
find rough edges. If something looks off, open an issue on this repo and it
gets fixed fast.

## What it does

1. **Reads your vault's own version.** Every scaffold from 1.5.0 carries a
   `.icor-for-life/` folder: `VERSION` says which version your copy was made
   from, and `manifest.json` describes that version as data.
2. **Fetches the latest version's manifest** from the URL in settings.
3. **Compares, and reports three things a version number alone cannot:**
   - **Canonical files.** For each file the scaffold ships, one of three
     answers: **missing** (copy it in), **changed upstream since you
     installed** (safe to update, you never touched it), or **edited by
     you** (keep it; the check never overwrites an edited file). Your own
     files, the ones the scaffold never shipped, are not drift and are not
     counted.
   - **Leftovers.** Files the scaffold removed or moved after your version
     that are still in your vault, each with the changelog line that says
     where it went. The three CSS snippets that moved into the theme in
     1.5.0 are the founding case: a vault updated by hand keeps the files
     and keeps them enabled, and paints every rule twice.
   - **Structure.** The rooms the scaffold relies on exist, the plugins it
     expects are installed and enabled, every Base points at a folder that
     is there, and every enabled CSS snippet has its file.
   - **Agent identity.** From scaffold 1.11.0 every agent contract
     (`06 AI Team/Agents/<Name>/AGENT.md`) carries a stable `myicor_id`, a
     lowercase UUID v4 minted once at hire and never changed. The check
     finds each shipped agent by that id, so an agent you renamed is
     reported as intact under your name, not as missing; a shipped agent
     whose contract carries no id, or a different id, is named with the
     fix. And every contract in the vault, shipped or your own, is checked:
     no id, a malformed id, the nil placeholder on something that is not a
     template, or two contracts sharing one id (that one is broken). A
     template is recognised by the nil placeholder
     `00000000-0000-0000-0000-000000000000` plus a name that starts with
     `Agent ` or `_`. The `.claude/agents/` shims are not checked for
     identity; they are files like any other.
4. **Reads the knowledge quality numbers**, when the scaffold's own
   `Scripts/check-quality.py --write` has written them. That script ships
   with ICOR for Life Scaffold 1.18.0 or later. See "Knowledge quality"
   below.
5. **Shows the result** as a dot in the status bar (green ok, orange
   attention, red broken), a summary when you click it, a report note, and
   a dashboard.

## What it never does

It never changes a scaffold file. The only things it writes are the report
note (one per day, in a folder you choose), its own `data.json`, its run
history under `.icor-for-life/icor-for-life-scaffold-check/` (regenerable,
per device; see below), and, if you keep the GitHub token in an env file,
that file's one `GITHUB_TOKEN` line.
What it reads is listed in `SECURITY.md`; since 0.2.0 that includes every
`06 AI Team/Agents/<Name>/AGENT.md` (your own agents' contracts too, for the
`myicor_id` in their frontmatter) and, only when a shipped agent is found
under a folder name of your own, the `.claude/agents/*.md` shims, to find
the one pointing at it. Obsidian Sync never carries hidden folders except
`.obsidian`, so on a vault received through Sync `.claude/*` and
`.icor-for-life/` read as missing: the check reports that and does not
throw. Deleting a
leftover, updating a file, enabling a plugin: those are yours to do, or your
AI's. The report ends with a prompt you can paste into your AI session to
have the fixes carried out, one change at a time, with the same rules the
report follows.

## The report

`06 AI Team/AI Team Knowledge/Scaffold Check/YYYY-MM-DD-scaffold-check.md`
by default. Frontmatter carries `health`, `installed_version`,
`latest_version` and the counts, so a Base or a script can read it. The body
groups findings by what to do: **Broken** first (structure the scaffold
relies on), then **Attention** (things to do), then **Info** (worth knowing).
Inside each, findings are grouped by kind (guidelines, SOPs, agents, ...) so
seventy missing files read as six guidelines and thirteen SOPs. Each finding
names the file, says what was found, and says what to do.

## Knowledge quality

The checks above ask whether the scaffold's own files are intact. This asks
whether your knowledge base is: notes that link to nothing, frontmatter
fields nobody defined, orphans, dangling links, captures left sitting in the
inbox. Thirteen metrics in all.

**This plugin does not measure any of it.** The scaffold's own script does:

```
Scripts/check-quality.py --write
```

**The script ships with ICOR for Life Scaffold 1.18.0.** On an older
scaffold it is not there yet, and this section stays empty until you update.

Run it in the ICOR for Life Terminal, or just ask your AI to check your
notes. It writes the numbers to `.icor-for-life/scripts/quality.json`, and
the next check reads them. Until it has run once, the report and the
dashboard carry one sentence saying so and how to fix it. Numbers older than
seven days are shown with a stale marker.

The split is deliberate. A script counting notes returns the same answer
every time, in milliseconds; a model asked the same question returns the
right shape most of the time, which is the worst reliability there is. The
script measures, the plugin shows, and your AI is left with the part it is
actually good at: deciding what to do about it.

The report gains a **Knowledge quality** section: the health, a metric table,
the counts, and the findings grouped under their metric, twenty per metric
with a "+n more" line. Its frontmatter gains `quality_health`,
`quality_generated`, `quality_stale` and one key per metric id.

## The dashboard

"Open the Scaffold dashboard" in the command palette, or the button in the
result window. It shows both healths side by side, the entity counts, and the
metric table with a trend line per metric drawn from your last thirty runs.
Nothing on it needs a hover and severity is always a word beside the colour,
so it reads the same on a phone as on a desktop. There is no chart library
and no network call: the trend is one inline SVG path.

## What the plugin writes outside the vault's notes

`.icor-for-life/` is the ICOR for Life suite's machine layer: a hidden folder
for data that a plugin or a script writes for another one to read. Obsidian
does not show, index or search it, so nothing in it is ever a note. Each
plugin owns one subfolder named after its id, the vault's scripts own
`scripts/`, and the rule for everything in there is that something
regenerates it. The full rule is `GL-1008-the-machine-layer` in the scaffold's
Guidelines.

This plugin reads `.icor-for-life/scripts/quality.json` (the script's, never
written here) and writes exactly one file of its own,
`.icor-for-life/icor-for-life-scaffold-check/history.json`: one record per
completed run, capped at the last ninety, feeding the dashboard's trend
lines. It is state, not a setting, which is why it is not in `data.json`.
Delete it and you lose the trend and nothing else; it refills from the next
check. Obsidian Sync does not carry hidden folders, so it is per device.

## Settings

| Setting | Default | What it is |
| --- | --- | --- |
| Latest manifest URL | the scaffold repository's `main` branch | Where the latest `.icor-for-life/manifest.json` is published. A raw file URL or a GitHub contents API URL. |
| Where your keys live | Obsidian's keychain when this Obsidian has one (1.11.4 and newer), else an env file | Which of the two backends holds the GitHub token. See "Where your keys live" below. |
| Env file | `06 AI Team/AI Team Knowledge/.env` | Vault-relative path of the KEY=value file used in env-file mode. Only its `GITHUB_TOKEN` line is ever written. |
| GitHub token | not set | Only for a private manifest URL. Saved to the backend above, sent only to that URL's host, never written anywhere else. The field is cleared once the token is saved; the line under it says where the token is. |
| Run on startup | on | Check once when the vault opens. |
| Write the report note | on | One note per day, overwritten on later runs that day. |
| Report folder | `06 AI Team/AI Team Knowledge/Scaffold Check` | Where the note goes. |

A check that cannot fetch the latest manifest says so in the status bar
(grey, "offline") and does not guess.

## Where your keys live

The plugin has one secret, the optional GitHub token, and since 0.3.0 it
is never kept in `data.json` (which rides along with every vault sync and
git push). Two backends, chosen by the "Where your keys live" setting:

- **Obsidian's keychain** (Settings, General, Keychain). The default on
  Obsidian 1.11.4 and newer. The token is stored under the id
  `icor-for-life-scaffold-check-github-token`, outside the vault folder and
  outside `data.json`. On desktop Obsidian keeps one encrypted blob per
  vault; on mobile one per device, shared across vaults. Obsidian Sync does
  not carry it, so every device holds its own copy: a token entered on the
  Mac is not on the iPad. On a phone, paste the token again in the plugin's
  settings; it stays on that device. The keychain is shared by every
  installed plugin, which is why the id carries this plugin's full name.
- **An env file in the vault.** A plain `KEY=value` file, by default
  `06 AI Team/AI Team Knowledge/.env` (the "Env file" setting). The path is
  relative to the vault root; an absolute path or a `..` segment is refused.
  The key is `GITHUB_TOKEN`. Comment lines start with `#`; a value runs from
  the `=` to the end of its line, so quotes would be part of it, and nothing
  is interpolated. If the key appears twice the last line counts. Saving in
  this mode rewrites (or appends) that one line and leaves every other byte
  of the file as it was. On an Obsidian older than 1.11.4 this is the only
  choice and the dropdown is disabled.

Only the selected backend is read. There is no fallback to the other one,
because a fallback would hide a misconfiguration behind a check that still
works. Changing the dropdown moves nothing by itself: the line under the
token field says where a token is right now ("in Obsidian's keychain", "in
the env file", "still in data.json", "not set") and offers a "Move to ..."
button for each place that is not the backend in use, plus Remove for the
one that is. The one automatic move: on the first load of 0.3.0 in
keychain mode, a token that 0.2.0 saved in `data.json` is moved into the
keychain and the field is blanked. Nothing is ever moved out of the
keychain on its own.

The token field is a password input, cleared once the token is saved. No
value is ever shown, echoed in a notice, or written to a log, not even
masked.

## Disclosures

**Account.** No account is required. The plugin works without any token
against the public scaffold repository. A GitHub account, and a token
from it, is needed only if you point the manifest URL at a private
repository of your own.

**Network use.** One HTTPS GET to the manifest URL in settings (by default
`raw.githubusercontent.com`, the scaffold repository), on startup if
enabled and on demand. If a token is set it is sent as a bearer header to
that URL's host and to nothing else. No file content leaves the vault.
There is no telemetry and no analytics.

## For scaffold maintainers

The manifest is built by the scaffold's own
`Scripts/build-scaffold-manifest.py` and checked by its release build. This
plugin reads schema 1: `version`, `rooms`, `plugins`, `snippets`, `files`
(path, sha256, kind, example), `bases`, `history` (per version: `removed`
with a `note`, `renamed`, `added`), and, from scaffold 1.11.1, `agents`. A
removal without a note fails the scaffold's own check before it ever reaches
a member, which is the property this whole design rests on: the reason a
file went is written down once, by the person who removed it, and every
vault reads that one line.

`agents` is a top-level array, sorted by name, one entry per shipped agent
that is not a template:

```json
{ "name": "Penn", "myicor_id": "d40ec637-e612-4baf-987c-a3ebb71a1536",
  "path": "06 AI Team/Agents/Penn/AGENT.md", "shim": ".claude/agents/penn.md" }
```

`shim` is `null` for an agent without one (Larry, the main-session
identity). The key is optional: a manifest without it (1.11.0 and older)
still runs every local-contract check, and the report carries one info line
saying the manifest predates agent identities, so shipped agents are matched
by path only. `schema` stays 1. The ids are the same UUIDs the scaffold's
`mint-agent-ids.py --export` prints, and the same ones a myICOR library row
for that agent carries as its primary key; the plugin never mints, changes,
or reuses one.

## Tests

`npm test` runs the engine against in-memory vaults: every defect the plugin
exists to find is planted and must be found, and a clean vault must produce
no findings. The red cases come first. The agent-identity gates use the real
ids of the shipped agents as fixtures.

## Releasing

A release is cut only when a version tag is pushed. A plain push to `main`
never releases anything.

1. Bump the version in 3 files: `manifest.json`, `versions.json` (new line, same `minAppVersion`) and `package.json`. Add the CHANGELOG entry.
2. Push to `main`. Nothing ships yet.
3. Flint reads the diff before ship. No read, no tag.
4. Tag the commit with the bare version and push the tag:
   `git tag -a 0.2.1 -m "ICOR for Life - Scaffold Check 0.2.1" && git push origin 0.2.1`
   (never `v0.2.1`: the Obsidian directory reads the tag as the version).

The Release workflow refuses a tag that does not equal `manifest.json`'s
version or that is not on `main`, then publishes `main.js`, `manifest.json` and `styles.css` with the commit subjects since the previous tag as notes.
The nightly version gate still checks that tag, branch and release agree.

## Licence

What you can do: install it, run it, read the code, modify your own copy,
and use it in your own business. What you cannot do: sell it, redistribute
it, or offer it (original or modified) as your own product or service to
others. Contributions: send a pull request. See `CONTRIBUTING.md`;
submitting one grants Paperless Movement the rights described in Section 7
of the LICENSE. This is not open source. It is source-available: the code
is visible, personal and business use are free, resale and republishing
are not. Bundled third-party components keep their own licenses; see
`THIRD-PARTY-NOTICES.md`.

Full text in LICENSE. Machine-readable identifier: LicenseRef-ICOR-Source-Available-1.0.
