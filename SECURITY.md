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
2. **Email** `team@myicor.com` with `SECURITY` and
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
file outside `.obsidian/`; `.obsidian/community-plugins.json` and
`appearance.json`; `.icor-for-life/VERSION` and `manifest.json`. Hashing runs
locally through the Web Crypto API. No file content leaves the vault.

**Writes.** One report note in the folder set in settings, and the plugin's
own `data.json`. Nothing else, ever. The plugin has no "fix" button on
purpose: a tool that can only read cannot be tricked into writing.

**Network.** One GET to the manifest URL in settings, on startup (if enabled)
and on demand. The default is the scaffold repository on GitHub. If a GitHub
token is set, it is sent as a bearer header to that URL and to nothing else.
There is no telemetry and no analytics.

**In scope, and we want to hear about it:**

- The token appearing anywhere other than `data.json` and the request header:
  in the report note, a log line, a notice, a URL.
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

- The token being stored in your own vault's `data.json`. That is the design;
  it is git-ignored here and by the scaffold. Exfiltration away from the
  vault is in scope; storage in it is not.
- Anyone with filesystem access to your vault reading `data.json`.
- Bugs in Obsidian itself, or breakage caused by another plugin.
- Missing hardening with no demonstrated impact.

## Good-faith research

We will not pursue legal action against anyone who reports in good faith,
gives us reasonable time to fix before disclosure, and tests only against
their own vault. There is no bug bounty; we credit you in the release notes
unless you would rather stay anonymous.
