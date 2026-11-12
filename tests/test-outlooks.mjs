import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { readOutlooks } from "../src/quota.ts";

let now;
beforeEach(() => {
  now = Date.UTC(2026, 0, 2);
  mock.method(Date, "now", () => now);
});
afterEach(() => mock.restoreAll());

function response(url, day = 25, timestamp = now) {
  const updated = new Date(timestamp).toISOString();
  return Response.json(
    url.includes("www.willcodexquotareset.com")
      ? {
          fetchedAt: updated,
          forecast: { horizonHours: 48, calibrated: false, score: 16 },
        }
      : {
          updated_at: updated,
          probabilities: { rounded_24h: day, rounded_48h: 50 },
        },
  );
}

function available(values) {
  return values.map((value) => value.available);
}

test("refreshes reuse persisted public readings until the one-minute boundary", async () => {
  const cache = new Map();
  let calls = 0;
  let day = 25;
  mock.method(globalThis, "fetch", async (url, options) => {
    calls++;
    assert.match(options.headers["User-Agent"], /^AI-Forecast .*github\.com/);
    return response(url, day);
  });
  assert.equal((await readOutlooks(undefined, cache))[0].day, 25);
  day = 30;
  now += 59_999;
  const reopenedCache = {
    get: (key) => cache.get(key),
    set: (key, value) => cache.set(key, value),
  };
  assert.equal((await readOutlooks(undefined, reopenedCache))[0].day, 25);
  assert.equal(calls, 2);
  now++;
  assert.equal((await readOutlooks(undefined, reopenedCache))[0].day, 30);
  assert.equal(calls, 4);
});

test("cached readings still expire by source timestamp, not cache age", async () => {
  const cache = new Map();
  let calls = 0;
  mock.method(globalThis, "fetch", async (url) => {
    calls++;
    return response(
      url,
      25,
      url.includes("www.willcodexquotareset.com") ? now : now - 3_599_999,
    );
  });
  assert.deepEqual(available(await readOutlooks(undefined, cache)), [
    true,
    true,
  ]);
  now += 2;
  assert.deepEqual(available(await readOutlooks(undefined, cache)), [
    false,
    true,
  ]);
  assert.equal(calls, 2);
});

for (const format of ["seconds", "HTTP date"]) {
  test(`429 Retry-After (${format}) delays only the affected source`, async () => {
    const cache = new Map();
    let firstCalls = 0;
    let secondCalls = 0;
    const retry =
      format === "seconds" ? "120" : new Date(now + 120_000).toUTCString();
    mock.method(globalThis, "fetch", async (url) => {
      if (url.includes("www.willcodexquotareset.com")) {
        secondCalls++;
      } else if (++firstCalls === 1) {
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": retry },
        });
      }
      return response(url);
    });
    assert.deepEqual(available(await readOutlooks(undefined, cache)), [
      false,
      true,
    ]);
    now += 60_000;
    assert.deepEqual(available(await readOutlooks(undefined, cache)), [
      false,
      true,
    ]);
    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 2);
    now += 60_000;
    assert.deepEqual(available(await readOutlooks(undefined, cache)), [
      true,
      true,
    ]);
    assert.equal(firstCalls, 2);
    assert.equal(secondCalls, 3);
  });
}

test("overlapping refreshes do not duplicate in-flight source requests", async () => {
  const cache = new Map();
  const pending = [];
  mock.method(
    globalThis,
    "fetch",
    (url) =>
      new Promise((resolve) => pending.push(() => resolve(response(url)))),
  );
  const initial = readOutlooks(undefined, cache);
  assert.deepEqual(available(await readOutlooks(undefined, cache)), [
    false,
    false,
  ]);
  assert.equal(pending.length, 2);
  pending.forEach((finish) => finish());
  assert.deepEqual(available(await initial), [true, true]);
  assert.deepEqual(available(await readOutlooks(undefined, cache)), [
    true,
    true,
  ]);
  assert.equal(pending.length, 2);
});

test("corrupt public cache is replaceable without hiding valid readings", async () => {
  const cache = new Map([
    ["codex-reset.com", "{broken"],
    ["willcodexquotareset.com", "null"],
  ]);
  mock.method(globalThis, "fetch", async (url) => response(url));
  assert.deepEqual(available(await readOutlooks(undefined, cache)), [
    true,
    true,
  ]);
});

test("an unavailable cache never causes untracked requests", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async (url) => {
    calls++;
    return response(url);
  });
  const cache = {
    get: () => undefined,
    set: () => {
      throw new Error("Storage unavailable");
    },
  };
  assert.deepEqual(available(await readOutlooks(undefined, cache)), [
    false,
    false,
  ]);
  assert.equal(calls, 0);
});

test("an already-cancelled view neither requests nor reserves a retry slot", async () => {
  const cache = new Map();
  let calls = 0;
  mock.method(globalThis, "fetch", async (url) => {
    calls++;
    return response(url);
  });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(available(await readOutlooks(controller.signal, cache)), [
    false,
    false,
  ]);
  assert.equal(calls, 0);
  assert.equal(cache.size, 0);
  assert.deepEqual(available(await readOutlooks(undefined, cache)), [
    true,
    true,
  ]);
});
