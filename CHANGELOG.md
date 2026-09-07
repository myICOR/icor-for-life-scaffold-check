# Changelog

All notable changes to ICOR for Life - Scaffold Check.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).

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
- 17 new gates, red first, with the shipped agents' real ids as fixtures.

## [0.1.0] - 2026-09-01

### Added
- First release. Read-only check of a vault against the latest ICOR for
  Life Scaffold: the version gap; canonical files as missing, changed
  upstream, or edited by you; leftovers the scaffold removed after your
  version, matched by content, with the changelog line that explains
  each; the rooms, the expected plugins, every Base's target folder,
  every enabled snippet's file. One report note, grouped by kind. The
  engine is pure and exported for `node --test`.
