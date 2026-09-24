# ICOR for Life - Scaffold Check

**Is your vault still the shape it should be?**

Compares your vault with the latest ICOR for Life Scaffold and, where your AI
team lives in the same vault, the latest myPKA, read-only, and writes you a
report: what is missing, what you changed, what moved, and what changed
upstream since your copy.

Part of the [ICOR for Life](https://myicor.com) suite.

## What it is for

A vault drifts. You move a folder, a plugin gets disabled, an update changes
a file you had edited, and none of it announces itself. Six months later
something does not work and there is no way to tell which of those it was.

This tells you, in one run, and hands you a report you can either work
through yourself or give to your AI team to fix.

It never changes anything. It only looks.

## Getting started

Run **Check the scaffold** from the command palette. The report lands in your
vault as a note.

## ICOR for Life and myPKA (0.7.0)

Since ICOR for Life Scaffold 2.0.0 the AI team is its own product, myPKA,
with its own version folder `.mypka/` next to `.icor-for-life/`. The check
first works out what this vault holds:

- **Both** (content and team in one vault): two sections in the report,
  "ICOR for Life (content)" and "myPKA (team)", each against its own latest
  release, plus whether the installed pair fits together.
- **Only the content** (the team lives in its own folder): the content is
  checked, and the team side is one line saying it lives elsewhere. Never a
  missing file.
- **Only the team** (a myPKA folder opened as a vault): the team is checked,
  and the content side is one line saying it lives elsewhere.

A team file the Scaffold stopped shipping at 2.0.0 because myPKA ships it
now is a move, not a leftover, and the report never tells you to delete it.
Until the myPKA manifest URL is set, those files are not judged at all, and
one line says so.

## What the report tells you

**Canonical files.** For each file the Scaffold ships, one of three answers:
missing, changed by you, or changed upstream since your copy. Three different
answers with three different actions, and a file you edited is never
overwritten.

**Leftovers.** Files the Scaffold removed or moved after your version that
are still sitting in your vault, each pointing at the changelog line that
says where it went.

**Structure.** Whether the rooms exist, whether the plugins your vault expects
are enabled, and whether every saved view still points at a folder that is
there.

**Generated files.** Scaffold 1.23.0 and later write your AI-host files
(skills, agent shims, hook configs) from your own vault rather than shipping
them fixed, so yours are meant to differ from everyone else's. These are read
as generated and never as something you edited: each one carries its own
content hash, and the report only speaks up when that hash no longer matches,
which means somebody edited a file the generator is about to overwrite. The
fix is always to change the source and re-run the generator, never to edit
the file and never to copy one in.

**Knowledge quality.** How healthy the notes themselves are, not just the
files: notes with no link, invented properties, orphans, dangling links,
captures left sitting in the inbox. With a dashboard showing each number's
trend over time.

**Your AI hosts.** Which of Claude Code, Codex, Gemini CLI and Cursor this
vault is actually wired to, what each one has installed, and what each one
cannot do at all. Read from what the Scaffold's own `scaffold-init.py doctor`
found; if you have never run it, the report says so and gives you the command.

**A prompt for your AI.** The report ends with one, so you can hand the whole
thing over and have it propose fixes before anything is applied.

## What it touches

- **Reads your vault**, and writes exactly one file: the report.
- **Fetches the latest manifests** so it knows what to compare against. Two
  network calls at most, both plain GET requests for a JSON file:
  - the latest ICOR for Life manifest, from "Latest ICOR for Life manifest
    URL" in settings (by default the Scaffold's `manifest.json` on GitHub);
  - the latest myPKA manifest, from "Latest myPKA manifest URL", only when
    you have set one. It is blank by default and the plugin never guesses it.

  If you save a GitHub token (for a private repository), it is sent only to
  `github.com`, `api.github.com` and `raw.githubusercontent.com`, never to any
  other host a URL setting names. Nothing about your vault is ever sent.

**It changes nothing else, ever.** The whole design is read-only.

## Good to know

- **It reports; you decide.** Nothing is fixed automatically.
- **A vault with no `.icor-for-life/` folder** cannot be compared precisely.
  The report says so rather than guessing.
- **Obsidian Sync does not carry dot folders**, so on a device that got the
  vault through Sync, `.icor-for-life/`, `.mypka/` and `.claude/` are not
  there. The report says that in one line per product instead of listing
  every file as missing. Run the check on the device you installed on.
- **Beta.** In daily use in a real vault, and you will find rough edges. If
  something looks off, open an issue.

## Support

What myICOR supports: the plugin as published in a tagged release, on the
current version, installed from that release. Bugs go to this repo's issues,
security reports to the process in `SECURITY.md`.

What the community maintains: anything marked community-maintained, including
community source adapters. We review it before it is merged. We do not support
it, we cannot promise it keeps working, and it can be disabled or removed in
any release.

What is yours: your own changes, your fork, your local patch. Please reproduce
the problem on a clean install of the current release before reporting it.

## Licence

MIT, see `LICENSE`. Install it, run it, read it, change it, sell it, ship it in
your own product; keep the copyright and licence notice.
Releases before 0.6.0 stay under the ICOR for Life
Source-Available License (Code) v1.0 they were published with.

The licence covers the code only. "ICOR", "ICOR for Life", "myICOR" and
"Paperless Movement" are trademarks of Paperless Movement, S.L.; a fork needs
its own plugin id and name. See `TRADEMARK.md`.

Contributions are welcome as pull requests under the same MIT terms, with a
DCO sign-off on every commit. See `CONTRIBUTING.md`.

Bundled third-party components keep their own licences; see
`THIRD-PARTY-NOTICES.md`.
