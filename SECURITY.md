# Security Policy

ICOR for Life - Scaffold Check is an Obsidian plugin that reads your vault,
fetches one JSON file from a URL you configure, and writes one report note.
It is read-only by design. The parts worth attacking are small, and we would
rather hear about a problem early than read about it later.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security problem.**

Two channels, in order of preference:

1. **GitHub private security advisory** (preferred). Go to the
   [Security tab](https://github.com/myICOR/icor-for-life-scaffold-check/security/advisories/new)
   of this repository and open a draft advisory.
2. **Email** `support@myicor.com` with `SECURITY` and
   `icor-for-life-scaffold-check` in the subject line.

A useful report contains the plugin version (`manifest.json`), your Obsidian
version and operating system, what an attacker can do and what they need in
order to do it, and steps to reproduce against a throwaway vault. **Never
send a real token.** Describe it; do not paste it.

## What to expect

| Stage | Target |
| --- | --- |
| We acknowledge your report | within 5 business days |
| We tell you whether we agree, and how severe | within 10 business days |
| We ship a fix for a confirmed critical or high issue | we aim for 30 days |
| We ask you to hold public disclosure until | a fix ships, or 90 days from your report |

## Supported versions

**Only the most recent release is supported.** One branch, no backports.

## Scope: what this plugin actually touches

**Reads.** Every file the latest manifest names, to hash it; every `.base`
file outside the config folder; the config folder's (`.obsidian/` by
default) `community-plugins.json` and `appearance.json`; `.icor-for-life/VERSION`
and `manifest.json`. Since 0.2.0, for the agent-identity check: every
`06 AI Team/Agents/<Name>/AGENT.md`, including contracts of your own agents
that the scaffold never shipped (only the frontmatter is used, to read
`myicor_id` and `name`); and `.claude/agents/*.md`, read only in the
renamed-agent case, to find the shim that points at a shipped agent's
contract under your own folder name. Hashing runs locally through the Web
Crypto API. No file content leaves the vault, and nothing from a contract
or a shim is written anywhere but the report's finding lines, which name
paths, never content.

**Writes.** One report note in the folder set in settings, and the plugin's
own `data.json`. In env-file mode, one more: the `GITHUB_TOKEN` line of the
env file named in settings, rewritten or appended when you save or move the
token, every other byte of that file left as it was. Nothing else, ever.
The plugin has no "fix" button on purpose: a tool that can only read cannot
be tricked into writing.

**The token.** Since 0.3.0 it lives in Obsidian's keychain
(`app.secretStorage`, id `icor-for-life-scaffold-check-github-token`) or,
by your choice or on an Obsidian older than 1.11.4, in that env file. It is
not in `data.json` any more; a token 0.2.0 left there is moved into the
keychain on first load in keychain mode, and otherwise shown in the settings
tab with a button to move it. Obsidian's keychain is shared by every
installed plugin: any plugin can read any id, which is why ours carries the
full plugin name, and why a plugin you do not trust should not be installed
next to a token you care about. On mobile the keychain is per device, not
per vault.

**Network.** One GET to the manifest URL in settings, on startup (if enabled)
and on demand. The default is the scaffold repository on GitHub. If a GitHub
token is set, it is sent as a bearer header to that URL and to nothing else.
There is no telemetry and no analytics.

**In scope, and we want to hear about it:**

- The token appearing anywhere other than its backend (the keychain entry or
  the env file's `GITHUB_TOKEN` line) and the request header: in the report
  note, `data.json`, a log line, a notice, a URL, the settings tab.
- The env-file writer touching any byte of that file other than the
  `GITHUB_TOKEN` line, or a value that turns into a second line.
- A manifest served by an attacker causing the plugin to write outside the
  report folder, or to write anything but the report. The manifest carries
  paths; those paths are only ever READ and hashed, never written or
  deleted, and a report that names a path is text. If you can make it more
  than text, that is the report we most want.
- The report note rendering manifest-controlled strings as anything other
  than inert markdown.
- TLS verification being skipped or downgraded on the manifest request.
- Path traversal: a manifest path like `../../` reaching outside the vault
  through the adapter.

## Out of scope

- The token being readable by another plugin through Obsidian's keychain, or
  being in your own vault's env file when you chose that backend. Both are
  the design: the keychain is shared by Obsidian's own rule, and the env file
  is inside the vault by yours (the default path is git-ignored by the
  scaffold). Exfiltration away from the vault is in scope; storage in it is
  not.
- Anyone with filesystem access to your vault reading the env file, or a
  `data.json` written by 0.2.0 before the first load of 0.3.0.
- Bugs in Obsidian itself, or breakage caused by another plugin.
- Missing hardening with no demonstrated impact.

## Good-faith research

We will not pursue legal action against anyone who reports in good faith,
gives us reasonable time to fix before disclosure, and tests only against
their own vault. There is no bug bounty; we credit you in the release notes
unless you would rather stay anonymous.
