# ICOR for Life - Scaffold Check

**Is your vault still the shape it should be?**

Compares your vault with the latest ICOR for Life Scaffold, read-only, and
writes you a report: what is missing, what you changed, what moved, and what
the Scaffold changed since your copy.

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
- **Fetches the latest Scaffold manifest** from the URL in settings, so it
  knows what to compare against. That is its only network call.

**It changes nothing else, ever.** The whole design is read-only.

## Good to know

- **It reports; you decide.** Nothing is fixed automatically.
- **A vault with no `.icor-for-life/` folder** cannot be compared precisely.
  The report says so rather than guessing.
- **Beta.** In daily use in a real vault, and you will find rough edges. If
  something looks off, open an issue.

## Support

Open an issue on this repository. For security problems, see `SECURITY.md`.

## Licence

Source-available, see `LICENSE`. Not open source. Bundled third-party
components: see `THIRD-PARTY-NOTICES.md`.
