import test from "node:test";
import assert from "node:assert/strict";
import {
  migrateState,
  parseSnapshot,
  renderForecast,
  validateState,
} from "../src/forecast-model.ts";

const NOW = 2_000_000_000,
  HOUR = 3600,
  DAY = 86400;
const iso = (time) => new Date(time * 1000).toISOString();
const quota = (used, reset = NOW + 4 * DAY, window = 7 * DAY) => ({
  kind: "consumption",
  utilization: used,
  resetsAt: iso(reset),
  windowSeconds: window,
});
const provider = (resources, time = NOW, extra = {}) => ({
  plan: "Pro 100",
  fetchedAt: iso(time),
  expiresAt: iso(time + 600),
  stale: false,
  resources,
  ...extra,
});
const v1 = (providers, errors = []) =>
  parseSnapshot({ schema: "openusage.limits.v1", providers, errors });
const v2 = (providers) =>
  parseSnapshot({ schema: "openusage.limits.v2", providers });
const initial = () => ({ version: 3, windows: {} });
const windowState = (samples, reset = NOW + 4 * DAY) => ({
  reset,
  samples,
  pending: null,
  risk_alert: null,
  exhausted: false,
});
function harness(state = initial()) {
  const events = [],
    commits = [];
  async function run(
    snapshot,
    now = NOW,
    notifier = (title, body) => {
      events.push({ title, body });
    },
  ) {
    migrateState(state, snapshot.providers);
    return renderForecast(snapshot, state, now, notifier, async () => {
      commits.push(structuredClone(state));
    });
  }
  async function sample(offset, used, reset = NOW + 4 * DAY) {
    const now = NOW + offset;
    return run(
      v1({ codex: provider({ weekly: quota(used, reset) }, now) }),
      now,
    );
  }
  return { state, events, commits, run, sample };
}

test("validates inputs and preserves legacy state fields without mutation", () => {
  for (const input of [
    null,
    {},
    { schema: "openusage.limits.v2", providers: { "codex@bad\t": {} } },
    { schema: "openusage.limits.v2", providers: { "codex@one": null } },
  ])
    assert.throws(() => parseSnapshot(input));
  const state = {
    version: 1,
    windows: {
      "codex.weekly": {
        ...windowState([
          [NOW, 0.1],
          [NOW + 1, 0.2],
        ]),
        future: "retained",
      },
    },
    unknown: true,
  };
  const before = structuredClone(state);
  validateState(state);
  assert.deepEqual(state, before);
  for (const invalid of [
    null,
    {
      version: 3,
      windows: {
        "codex.weekly": windowState([
          [NOW, 0.1],
          [NOW, 0.2],
        ]),
      },
    },
    { version: 3, windows: { "codex.weekly": windowState([[NOW, -1]]) } },
    { version: 3, windows: {}, legacy_bindings: { codex: "claude@x" } },
  ])
    assert.throws(() => validateState(invalid));
});

test("legacy binding is atomic, unambiguous, explicit, and sticky across formats", async () => {
  const legacy = windowState([[NOW, 1]]);
  legacy.exhausted = true;
  const state = { version: 1, windows: { "codex.weekly": legacy } };
  const multiple = v2({
    "codex@one": provider({ weekly: quota(1) }),
    "codex@two": provider({ weekly: quota(0.2) }),
  });
  const before = structuredClone(state);
  assert.throws(() => migrateState(state, multiple.providers));
  assert.deepEqual(state, before);
  assert.throws(() =>
    migrateState(state, multiple.providers, [
      "codex=codex@one",
      "claude=claude@missing",
    ]),
  );
  assert.deepEqual(state, before);
  migrateState(state, multiple.providers, ["codex=codex@one"]);
  assert.deepEqual(state.windows["codex@one.weekly"], legacy);
  assert.equal(state.legacy_bindings.codex, "codex@one");
  const h = harness(state);
  await h.run(multiple);
  await h.run(v1({ codex: provider({ weekly: quota(1) }) }));
  assert.equal(h.events.length, 0);
  assert.deepEqual(state.windows["codex@two.weekly"].samples, [[NOW, 0.2]]);
  assert.equal(state.legacy_bindings.codex, "codex@one");
  const collision = {
    version: 2,
    windows: {
      "codex.weekly": windowState([]),
      "codex@one.weekly": windowState([]),
    },
  };
  const original = structuredClone(collision);
  assert.throws(() =>
    migrateState(collision, multiple.providers, ["codex=codex@one"]),
  );
  assert.deepEqual(collision, original);
});

test("account isolation, sanitized display, partial status and zero usage", async () => {
  const h = harness();
  const result = await h.run(
    v2({
      "codex@one": provider({ weekly: quota(1) }, NOW, {
        displayName: "Work\taccount\n",
      }),
      "codex@two": provider({ weekly: quota(0) }),
      "other@x": provider({ weekly: quota(1) }),
    }),
  );
  assert.equal(h.events.length, 1);
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].providerName, "Work account");
  assert.deepEqual(h.state.windows["codex@two.weekly"].samples, [[NOW, 0]]);
  const partial = await h.run(
    v1(
      {
        codex: provider({ session: quota(0.2) }, NOW, {
          plan: "Pro\t100\nInjected\0",
        }),
      },
      [{}],
    ),
  );
  assert.equal(partial.severity, "yellow");
  assert.equal(partial.windows[0].plan, "Pro 100 Injected");
});

test("stale, future and out-of-order readings cannot change state or alert", async () => {
  const h = harness();
  await h.sample(0, 1);
  await h.sample(300, 1, NOW + 5 * DAY);
  const before = structuredClone(h.state);
  const old = await h.run(
    v1({ codex: provider({ weekly: quota(1) }, NOW) }),
    NOW + 300,
  );
  assert.equal(old.windows[0].severity, "unavailable");
  for (const extra of [
    { stale: true },
    { expiresAt: iso(NOW - 1) },
    { fetchedAt: iso(NOW + 301) },
    { fetchedAt: null },
    { fetchedAt: iso(NOW - 901), expiresAt: null },
  ]) {
    const result = await h.run(
      v1({ codex: provider({ weekly: quota(1) }, NOW, extra) }),
      NOW + 300,
    );
    assert.equal(result.windows[0].severity, "unavailable");
  }
  assert.deepEqual(h.state, before);
  assert.equal(h.events.length, 2);
});

test("weekly allowance and pace use enough independent readings", async () => {
  const h = harness();
  let result;
  for (const [offset, used] of [
    [0, 0.2],
    [3 * HOUR, 0.25],
    [6 * HOUR, 0.3],
  ])
    result = await h.sample(offset, used);
  const projection = result.windows[0].forecast;
  assert.match(projection.detail, /18\.7 quota points\/day/);
  assert.match(projection.detail, /24\.6 quota points\/day/);
  assert.equal(projection.severity, "yellow");
  assert.equal(h.events.length, 0);
});

test("sustained risk needs distinct observations, supports retries, recovery and cooldown", async () => {
  const h = harness();
  for (const [offset, used] of [
    [0, 0.57],
    [3 * HOUR, 0.585],
    [6 * HOUR, 0.6],
    [6 * HOUR, 0.6],
    [6 * HOUR + 900, 0.61],
  ])
    await h.sample(offset, used);
  assert.equal(h.events.length, 0);
  const now = NOW + 6 * HOUR + 1800,
    snapshot = v1({ codex: provider({ weekly: quota(0.62) }, now) });
  await assert.rejects(
    h.run(snapshot, now, async () => {
      throw new Error("dispatch failed");
    }),
  );
  assert.equal(h.state.windows["codex.weekly"].risk_alert, null);
  await h.run(snapshot, now);
  assert.equal(h.events.length, 1);
  assert.equal(h.commits.length, 1);
  await h.run(snapshot, now);
  await h.sample(7 * HOUR, 0.9);
  assert.equal(h.events.length, 1);
  await h.sample(30 * HOUR + 1800, 0.99);
  assert.equal(h.events.length, 2);
  const idle = harness();
  for (const [offset, used] of [
    [0, 0.57],
    [3 * HOUR, 0.585],
    [6 * HOUR, 0.6],
    [54 * HOUR, 0.6],
  ])
    await idle.sample(offset, used);
  assert.equal(idle.state.windows["codex.weekly"].pending, null);
  assert.equal(idle.events.length, 0);
});

test("each exhaustion commits before later failure and retries only failed window", async () => {
  const h = harness();
  const data = v1({ codex: provider({ weekly: quota(1), session: quota(1) }) });
  let calls = 0;
  await assert.rejects(
    h.run(data, NOW, async () => {
      if (++calls === 2) throw new Error("failure");
    }),
  );
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].windows["codex.weekly"].exhausted, true);
  assert.equal(h.state.windows["codex.session"].exhausted, false);
  await h.run(data);
  await h.run(data);
  assert.equal(h.events.length, 1);
  assert.match(h.events[0].title, /session/);
});

test("counter drop and known profile change reset deduplication", async () => {
  const h = harness();
  for (const [offset, used] of [
    [0, 1],
    [300, 1],
    [600, 0.5],
    [900, 1],
  ])
    await h.sample(offset, used);
  assert.equal(h.events.length, 2);
  const now = NOW + 1200;
  await h.run(
    v1({ codex: provider({ weekly: quota(1) }, now, { plan: "Other" }) }),
    now,
  );
  assert.equal(h.events.length, 3);
  assert.equal(h.state.windows["codex.weekly"].cycles.length, 0);
  assert.deepEqual(h.state.windows["codex.weekly"].samples, [[now, 1]]);
});

test("legacy observations retain provenance without inventing a rate", async () => {
  const samples = [
    [NOW, 0.6],
    [NOW + 3 * HOUR, 0.65],
    [NOW + 6 * HOUR, 0.7],
  ];
  const record = {
    ...windowState(samples),
    pending: { since: NOW + 5 * HOUR, count: 3 },
  };
  const h = harness({ version: 2, windows: { "codex.weekly": record } });
  const now = NOW + 6 * HOUR;
  await h.run(
    v1({ codex: provider({ weekly: quota(0.7) }, now, { plan: null }) }),
    now,
  );
  const item = h.state.windows["codex.weekly"];
  assert.deepEqual(item.legacy_samples, samples);
  assert.deepEqual(item.samples, [[now, 0.7]]);
  assert.deepEqual(item.cycles, []);
  assert.equal(item.pending, null);
  assert.equal(h.events.length, 0);
});

test("completed compatible cycles provide provisional and then blended estimates", async () => {
  const h = harness(),
    reset = NOW + 4 * DAY,
    window = 7 * DAY;
  for (const [offset, used] of [
    [0, 0.87],
    [3 * HOUR, 0.885],
    [6 * HOUR, 0.9],
  ])
    await h.sample(offset, used, reset);
  let result;
  for (const [offset, used] of [
    [HOUR, 0.1],
    [2 * HOUR, 0.11],
    [3 * HOUR, 0.12],
  ]) {
    const now = reset + offset;
    result = await h.run(
      v1({
        codex: provider({ weekly: quota(used, reset + window, window) }, now),
      }),
      now,
    );
  }
  assert.equal(h.state.windows["codex.weekly"].cycles.length, 1);
  assert.equal(h.state.windows["codex.weekly"].pending, null);
  for (const [offset, used] of [
    [4 * HOUR, 0.13],
    [7 * HOUR, 0.16],
  ]) {
    const now = reset + offset;
    result = await h.run(
      v1({
        codex: provider({ weekly: quota(used, reset + window, window) }, now),
      }),
      now,
    );
  }
  assert.match(result.windows[0].forecast.detail, /34\.5 quota points\/day/);
});

test("session history retains only four complete compatible cycles", async () => {
  const h = harness(),
    window = 5 * HOUR;
  for (let cycle = 0; cycle < 6; cycle++) {
    const start = NOW + cycle * window,
      reset = start + window;
    for (const [offset, used] of [
      [0, 0.05],
      [1800, 0.1],
      [3600, 0.15],
    ]) {
      const now = start + offset;
      await h.run(
        v1({ codex: provider({ session: quota(used, reset, window) }, now) }),
        now,
      );
    }
  }
  const item = h.state.windows["codex.session"];
  assert.deepEqual(
    item.cycles.map((cycle) => cycle.reset),
    [2, 3, 4, 5].map((n) => NOW + n * window),
  );
  assert.ok(
    item.cycles.every((cycle) => cycle.readings === 3 && cycle.span === HOUR),
  );
  validateState(h.state);
});

test("incompatible profiles and reset changes before the boundary do not archive", async () => {
  const h = harness(),
    window = 5 * HOUR,
    reset = NOW + window;
  for (const [offset, used] of [
    [0, 0.1],
    [1800, 0.2],
    [3600, 0.3],
  ]) {
    const now = NOW + offset;
    await h.run(
      v1({ codex: provider({ session: quota(used, reset, window) }, now) }),
      now,
    );
  }
  let now = NOW + 2 * HOUR;
  await h.run(
    v1({
      codex: provider({ session: quota(0.1, reset + window, window) }, now),
    }),
    now,
  );
  assert.deepEqual(h.state.windows["codex.session"].cycles, []);
  now = reset + window + 1;
  await h.run(
    v1({
      codex: provider(
        { session: quota(0.1, reset + 2 * window, window) },
        now,
        { plan: "Other" },
      ),
    }),
    now,
  );
  assert.deepEqual(h.state.windows["codex.session"].cycles, []);
});

test("samples retain at most 24 hours and 2048 readings", async () => {
  const h = harness();
  for (let offset = 0; offset < 2050; offset++) await h.sample(offset, 0.2);
  assert.equal(h.state.windows["codex.weekly"].samples.length, 2048);
  assert.equal(h.state.windows["codex.weekly"].samples[0][0], NOW + 2);
  await h.sample(DAY + 2050, 0.2);
  assert.deepEqual(h.state.windows["codex.weekly"].samples, [
    [NOW + DAY + 2050, 0.2],
  ]);
});

test("same-fetch counter conflicts fail closed and a new window profile can reset earlier", async () => {
  const h = harness(),
    reset = NOW + 5 * HOUR;
  await h.run(
    v1({ codex: provider({ session: quota(0.5, reset, 5 * HOUR) }) }),
  );
  const conflict = await h.run(
    v1({ codex: provider({ session: quota(1, reset, 5 * HOUR) }) }),
  );
  assert.equal(conflict.windows[0].severity, "unavailable");
  assert.equal(h.events.length, 0);
  const now = NOW + 300;
  const changed = await h.run(
    v1({
      codex: provider({ session: quota(1, NOW + 3 * HOUR, 3 * HOUR) }, now),
    }),
    now,
  );
  assert.equal(changed.windows[0].severity, "red");
  assert.equal(h.events.length, 1);
  assert.equal(h.state.windows["codex.session"].reset, NOW + 3 * HOUR);
  assert.deepEqual(h.state.windows["codex.session"].cycles, []);
});

test("invalid calendar timestamps cannot create fresh samples or exhaustion alerts", async () => {
  const now = Date.UTC(2026, 2, 2, 12) / 1000;
  const h = harness();
  const result = await h.run(
    v2({
      "codex@fixture": provider({ weekly: quota(1, now + 7 * DAY) }, now, {
        fetchedAt: "2026-02-30T12:00:00Z",
      }),
    }),
    now,
  );
  assert.equal(result.windows[0].severity, "unavailable");
  assert.deepEqual(h.state.windows, {});
  assert.deepEqual(h.events, []);
});

test("submillisecond fetch times remain distinct and preserve legacy timestamp ordering", async () => {
  const h = harness();
  const fetchedAt = iso(NOW).replace(".000Z", ".123456Z");
  await h.run(
    v2({
      "codex@fixture": provider({ weekly: quota(0.2) }, NOW, { fetchedAt }),
    }),
    NOW + 1,
  );
  assert.deepEqual(h.state.windows["codex@fixture.weekly"].samples, [
    [NOW + 0.123456, 0.2],
  ]);
  const conflicting = await h.run(
    v2({ "codex@fixture": provider({ weekly: quota(1) }, NOW, { fetchedAt }) }),
    NOW + 1,
  );
  assert.equal(conflicting.windows[0].severity, "unavailable");
  assert.deepEqual(h.events, []);
});
