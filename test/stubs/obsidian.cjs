/* A stand-in for the `obsidian` module, for tests only.
 *
 * main.js guards `require('obsidian')` so the pure engine can be tested
 * without Obsidian, which also means the plugin class, and every method on
 * it, exists ONLY when that require succeeds. Anything that has to be
 * exercised on the plugin itself, rather than on the engine, needs this.
 *
 * It carries exactly what main.js destructures at load time and nothing
 * else: the base classes it extends and the few functions it calls. The
 * classes are empty on purpose. A test builds its subject with
 * `Object.create(Plugin.prototype)` and assigns the two or three fields the
 * method under test reads, so nothing here pretends to be Obsidian's
 * behaviour and no test can come to depend on a fake of it.
 */

'use strict';

class Plugin {}
class PluginSettingTab {}
class Modal {}
class ItemView {}

/* Setting's real shape is a chainable builder. Nothing in a test reaches it
   today; it exists so main.js can load. */
class Setting {
  constructor() {}
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
  addToggle() { return this; }
  addButton() { return this; }
  addDropdown() { return this; }
}

class Notice { constructor(message) { this.message = message; } }

const Platform = { isMobile: false, isDesktopApp: true };

async function requestUrl() { throw new Error('requestUrl is not available in tests'); }

/* Obsidian's own: collapse repeats, drop a leading and trailing slash. */
function normalizePath(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

module.exports = { Plugin, PluginSettingTab, Setting, Notice, Modal, ItemView, Platform, requestUrl, normalizePath };
