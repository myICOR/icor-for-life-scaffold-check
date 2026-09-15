/* THE LOCAL-DAY GATES.
 *
 * A report note is dated by the day the person is living in, never by the
 * UTC instant the run happened at. Sliced from the instant, the two
 * disagree either side of UTC: west of it an evening run writes TOMORROW's
 * date onto today's findings, east of it an early-morning run writes
 * YESTERDAY's and overwrites the note that is already there. Two clocks are
 * enough to show both.
 *
 * The clock is owned by the test rather than passed into the code, because
 * a `now` parameter that only tests ever supply proves the parameter works
 * and not that the plugin reads the clock correctly. `writeReport` keeps
 * the signature it ships with, and the test replaces the global Date.
 *
 * Same rule as the other gates (GL-005 rule 4): the red cases come first,
 * and the source-level guard at the end is what stops the slice coming back
 * somewhere else in the file.
 *
 * Overwriting the SAME day's note on a second run that day is the design,
 * not a defect: the settings text promises "one note per day, overwritten
 * on each run that day". These tests pin the day, never the overwrite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/* main.js guards `require('obsidian')` so the pure engine runs under
   `node --test`, which also means the plugin class, and `writeReport` with
   it, exists ONLY when that require succeeds. The stub is resolved into
   place before main.js loads; every other specifier goes to Node's own
   resolver untouched. */
const Module = require('node:module');
const STUB = join(here, 'stubs', 'obsidian.cjs');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'obsidian' ? STUB : resolveFilename.call(this, request, ...rest);
};

const ScaffoldCheckPlugin = require('../main.js');
const { engine } = ScaffoldCheckPlugin;

/* ------------------------------------------------------------- clocks -- */

/* The two zones. Neither observes DST, so the offset in the name is the
   offset all year and these tests do not drift into summer time.
     Panama       UTC-5, 19:07 local -> 2026-09-16T00:07Z, a day AHEAD
     Johannesburg UTC+2, 01:00 local -> 2026-09-14T23:00Z, a day BEHIND
   Both are 2026-09-15 where the person is sitting. */
const CLOCKS = [
  { zone: 'America/Panama', label: 'UTC-5, 19:07', at: [2026, 8, 15, 19, 7], utcDay: '2026-09-16' },
  { zone: 'Africa/Johannesburg', label: 'UTC+2, 01:00', at: [2026, 8, 15, 1, 0], utcDay: '2026-09-14' },
];
const LOCAL_DAY = '2026-09-15';

/* Runs `fn` with the wall clock in `zone` and `new Date()` answering the
   given local wall-clock readings in order, the last one repeating. One
   reading is a frozen clock; several is a clock that ticks BETWEEN two
   reads, which is the only way to tell one reading of it from two.
   Node re-reads process.env.TZ on assignment, and the readings are built
   from local parts because that is what a wall clock in that zone says. */
async function withClock(zone, readings, fn) {
  const Real = Date;
  const previous = process.env.TZ;
  process.env.TZ = zone;
  const queue = readings.map((r) => new Real(r[0], r[1], r[2], r[3], r[4], r[5] || 0, r[6] || 0).getTime());
  let i = 0;
  const tick = () => queue[Math.min(i++, queue.length - 1)];
  class FakeDate extends Real {
    constructor(...args) { super(...(args.length ? args : [tick()])); }
    static now() { return tick(); }
  }
  globalThis.Date = FakeDate;
  try { return await fn(); } finally { globalThis.Date = Real; process.env.TZ = previous; }
}

/* ------------------------------------------------------------ fixture -- */

/* A vault that is only what writeReport touches: exists, mkdir, write. */
function fakeApp() {
  const files = new Map();
  const folders = new Set();
  return {
    files,
    folders,
    app: {
      vault: {
        configDir: '.obsidian',
        adapter: {
          exists: async (p) => files.has(p) || folders.has(p),
          mkdir: async (p) => { folders.add(p); },
          write: async (p, text) => { files.set(p, text); },
        },
      },
    },
  };
}

/* The plugin without Plugin's constructor: writeReport reads `app` and
   `settings` and nothing else, so those are all that is supplied. */
function pluginOn(app, settings) {
  const p = Object.create(ScaffoldCheckPlugin.prototype);
  p.app = app;
  p.settings = Object.assign({ reportFolder: 'Reports', manifestUrl: 'https://example.test/m.json' }, settings || {});
  return p;
}

const result = (health, broken, attention, info) => ({
  health, counts: { broken, attention, info },
  installedVersion: '1.23.0', latestVersion: '1.23.0', findings: [],
});

const dateLine = (md) => (/^date: (.+)$/m.exec(md) || [])[1];
const heading = (md) => (/^# Scaffold Check, (.+)$/m.exec(md) || [])[1];
const dayOfPath = (p) => (/(\d{4}-\d{2}-\d{2})-scaffold-check\.md$/.exec(p) || [])[1];

/* ------------------------------------------- red 1: either side of UTC -- */

for (const c of CLOCKS) {
  test('RED (' + c.label + '): writeReport names the file for the local day, and the note agrees with its own name', async () => {
    const v = fakeApp();
    const plugin = pluginOn(v.app);
    await withClock(c.zone, [c.at], async () => {
      assert.equal(new Date().toISOString().slice(0, 10), c.utcDay, 'the fixture is only a test if the UTC slice disagrees');
      await plugin.writeReport(result('ok', 0, 0, 0), null, null);
    });

    const paths = [...v.files.keys()];
    assert.deepEqual(paths, ['Reports/' + LOCAL_DAY + '-scaffold-check.md']);
    assert.equal(plugin.lastReportPath, paths[0]);

    const md = v.files.get(paths[0]);
    assert.equal(dateLine(md), LOCAL_DAY, 'the frontmatter date is the local day');
    assert.equal(heading(md), LOCAL_DAY, 'and so is the heading');
    assert.ok(!md.includes(c.utcDay), 'the UTC day appears nowhere in the note');
  });

  test('RED (' + c.label + '): renderReport dates from the local day of the instant it is given', async () => {
    await withClock(c.zone, [c.at], () => {
      const md = engine.renderReport(result('ok', 0, 0, 0), { now: new Date() });
      assert.equal(dateLine(md), LOCAL_DAY);
      assert.equal(heading(md), LOCAL_DAY);
    });
  });
}

/* ----------------------------------------- red 2: one reading, not two -- */

test('RED: the day is read once, so the filename and the body cannot disagree', async () => {
  /* The defect was two readings of the clock: the filename took one instant
     and the body took another. Two seconds either side of UTC midnight, on
     a wall clock that does not move off 2026-09-15, is what separates one
     reading from two: sliced in UTC the first reading says the 15th and the
     second says the 16th, and only a day read once can agree with itself. */
  const v = fakeApp();
  const plugin = pluginOn(v.app);
  await withClock('America/Panama', [[2026, 8, 15, 18, 59, 59], [2026, 8, 15, 19, 0, 1]], async () => {
    await plugin.writeReport(result('attention', 0, 2, 1), null, null);
  });

  const path = [...v.files.keys()][0];
  const md = v.files.get(path);
  assert.equal(dateLine(md), dayOfPath(path), 'the note is dated for the file it is written to');
  assert.equal(heading(md), dayOfPath(path));
  assert.equal(dayOfPath(path), LOCAL_DAY, 'and the day both agree on is the local one');
});

/* --------------------------------------------- the day renderReport takes -- */

test('an explicit day wins over the instant, and a malformed one falls back to it', async () => {
  await withClock('America/Panama', [[2026, 8, 15, 19, 7]], () => {
    const now = new Date();
    assert.equal(dateLine(engine.renderReport(result('ok', 0, 0, 0), { now, today: '2026-01-02' })), '2026-01-02');
    for (const bad of ['', 'today', '2026-9-15', null, 7]) {
      assert.equal(dateLine(engine.renderReport(result('ok', 0, 0, 0), { now, today: bad })), LOCAL_DAY, 'falls back: ' + JSON.stringify(bad));
    }
  });
});

/* ------------------------------------------------------------ helpers -- */

test('localDayStr and localDayOfIso read the wall clock, never the instant', async () => {
  await withClock('America/Panama', [[2026, 8, 15, 19, 7]], () => {
    assert.equal(engine.localDayStr(new Date()), LOCAL_DAY);
    assert.equal(engine.localDayOfIso('2026-09-16T00:07:00.000Z'), LOCAL_DAY);
    assert.equal(engine.todayStr(), LOCAL_DAY);
    /* one-digit months and days are padded */
    assert.equal(engine.localDayStr(new Date(2026, 0, 2, 3, 4)), '2026-01-02');
    /* nothing parseable, nothing invented */
    for (const bad of [null, '', 'never', undefined, '2026-13-40T00:00:00Z']) assert.equal(engine.localDayOfIso(bad), '');
  });
});

/* ------------------------------------------------------------- source -- */

test('SOURCE: no calendar day in this file is the UTC slice of an instant', () => {
  const main = readFileSync(join(here, '..', 'main.js'), 'utf8');
  /* the comments carry the words on purpose, so they are dropped before the
     guard reads the file */
  const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/toISOString\(\)\.slice\(0, ?10\)/.test(code), 'a calendar day is never the first ten characters of an instant: use localDayStr');
  assert.ok(!/lastRun\.slice\(0, ?10\)/.test(code), 'lastRun is a stored instant, so the same rule holds when it is shown: use localDayOfIso');
});
