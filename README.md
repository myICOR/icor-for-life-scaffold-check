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
4. **Shows the result** as a dot in the status bar (green ok, orange
   attention, red broken), a summary when you click it, and a report note.

## What it never does

It never changes a scaffold file. The only things it writes are the report
note (one per day, in a folder you choose) and its own `data.json`. Deleting a
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

## Settings

| Setting | Default | What it is |
| --- | --- | --- |
| Latest manifest URL | the scaffold repository's `main` branch | Where the latest `.icor-for-life/manifest.json` is published. A raw file URL or a GitHub contents API URL. |
| GitHub token | empty | Only for a private manifest URL. Stored in this plugin's `data.json`, sent only to that URL's host, never written anywhere else. |
| Run on startup | on | Check once when the vault opens. |
| Write the report note | on | One note per day, overwritten on later runs that day. |
| Report folder | `06 AI Team/AI Team Knowledge/Scaffold Check` | Where the note goes. |

A check that cannot fetch the latest manifest says so in the status bar
(grey, "offline") and does not guess.

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
