/* A disk-backed vault for the engine: the same interface as the in-memory
 * `vault()` in engine.test.mjs and as the plugin's `vaultFs()`, over a real
 * folder. It answers the way Obsidian's desktop adapter does:
 *
 *   - `exists` follows symlinks and is true for files and folders alike;
 *   - the TFile index (`listBases`, `listScratchpads`) never holds a hidden
 *     file or folder, so the walk skips every dot entry, exactly as
 *     `app.vault.getFiles()` does;
 *   - dot folders are reached only through `exists` / `read` / `list`, the
 *     Adapter API, which is what the plugin uses for `.icor-for-life/` and
 *     `.mypka/`.
 *
 * Read-only. Nothing here writes.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const AGENTS_DIR = '06 AI Team/Agents';
const SKILLS_DIR = '06 AI Team/AI Team Knowledge/Skills';
const HOST_LINKS_DIR = '.agents/skills';

export function diskVault(root, { configDir = '.obsidian' } = {}) {
  const abs = (p) => join(root, p);
  const isDir = (p) => { try { return statSync(abs(p)).isDirectory(); } catch { return false; } };
  const kids = (p) => { try { return readdirSync(abs(p)); } catch { return []; } };

  /* Every visible file, the way the vault index sees it. */
  function walk(dir, out) {
    for (const name of kids(dir)) {
      if (name.startsWith('.')) continue;
      const p = dir ? dir + '/' + name : name;
      if (isDir(p)) walk(p, out); else out.push(p);
    }
    return out;
  }
  let index = null;
  const files = () => (index = index || walk('', []));

  return {
    exists: async (p) => existsSync(abs(p)),
    read: async (p) => readFileSync(abs(p), 'utf8'),
    readBinary: async (p) => readFileSync(abs(p)),
    listBases: async () => files().filter((p) => p.endsWith('.base') && !p.startsWith(configDir + '/')),
    listScratchpads: async () => files().filter((p) => p.startsWith('00 Daily Scratchpad/')),
    listAgentContracts: async () => kids(AGENTS_DIR)
      .map((n) => AGENTS_DIR + '/' + n + '/AGENT.md')
      .filter((p) => existsSync(abs(p))),
    listShims: async () => kids('.claude/agents').filter((n) => n.endsWith('.md')).map((n) => '.claude/agents/' + n),
    listSkillNames: async () => kids(SKILLS_DIR).filter((n) => isDir(SKILLS_DIR + '/' + n)),
    /* The plugin's own desktop logic, over node's fs. */
    hostSkillLinks: async (names) => {
      if (!existsSync(abs(HOST_LINKS_DIR))) return { supported: true, present: false, entries: [] };
      const entries = [];
      const seen = new Set();
      for (const name of names || []) {
        if (!name || seen.has(name)) continue;
        seen.add(name);
        entries.push({ name, resolves: existsSync(abs(HOST_LINKS_DIR + '/' + name + '/SKILL.md')), known: true });
      }
      let listed;
      try { listed = readdirSync(abs(HOST_LINKS_DIR)); } catch { return { supported: true, present: true, listable: false, entries }; }
      for (const name of listed) {
        if (name.startsWith('.') || seen.has(name)) continue;
        seen.add(name);
        entries.push({ name, resolves: existsSync(abs(HOST_LINKS_DIR + '/' + name + '/SKILL.md')), known: false });
      }
      return { supported: true, present: true, listable: true, entries };
    },
  };
}
