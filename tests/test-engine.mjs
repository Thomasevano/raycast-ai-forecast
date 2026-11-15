import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { processForecast } from "../src/forecast-engine.ts";

const execute = promisify(execFile);
const NOW = 2_000_000_000;
const iso = (seconds) => new Date(seconds * 1000).toISOString();
const migration = fileURLToPath(
  new URL("../scripts/migrate-history.ts", import.meta.url),
);
const worker = fileURLToPath(
  new URL("./fixtures/monitor-worker.mjs", import.meta.url),
);

function payload(used = 0.2, now = NOW) {
  return {
    schema: "openusage.limits.v2",
    providers: {
      "codex@fixture": {
        plan: "Pro 100",
        fetchedAt: iso(now),
        expiresAt: iso(now + 600),
        resources: {
          weekly: {
            kind: "consumption",
            utilization: used,
            resetsAt: iso(NOW + 4 * 86_400),
            windowSeconds: 7 * 86_400,
          },
        },
      },
    },
  };
}

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), "forecast-engine-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const stored = async (root) =>
  JSON.parse(await readFile(join(root, "state.json"), "utf8"));

async function assign(root, input, assignments) {
  const child = execFile(
    process.execPath,
    [
      migration,
      "--state-dir",
      root,
      ...assignments.flatMap((value) => ["--assign-legacy", value]),
    ],
    { timeout: 10_000 },
  );
  const result = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  child.stdin.end(JSON.stringify(input));
  return result;
}

test("the TypeScript preview returns the connected window without creating history or notifying", async (t) => {
  const root = await sandbox(t);
  const stateDirectory = join(root, "absent");
  const result = await processForecast(payload(1), {
    stateDirectory,
    now: NOW,
    preview: true,
    notifier: () => assert.fail("Preview must never dispatch a notification"),
  });
  assert.deepEqual(
    result.windows.map(({ id, severity }) => ({ id, severity })),
    [{ id: "codex@fixture.weekly", severity: "red" }],
  );
  await assert.rejects(stat(stateDirectory), { code: "ENOENT" });
});

test("successful alerts survive a later dispatch failure and preview cannot consume retries", async (t) => {
  const root = await sandbox(t);
  const input = payload(1);
  input.providers["codex@fixture"].resources.session = {
    kind: "consumption",
    utilization: 1,
    resetsAt: iso(NOW + 3600),
    windowSeconds: 5 * 3600,
  };
  const delivered = [];
  await assert.rejects(
    processForecast(input, {
      stateDirectory: root,
      now: NOW,
      notifier: (title) => {
        if (title.includes("session"))
          throw new Error("Synthetic delivery failure");
        delivered.push(title);
      },
    }),
  );
  const first = await stored(root);
  assert.equal(first.windows["codex@fixture.weekly"].exhausted, true);
  assert.equal(first.windows["codex@fixture.session"].exhausted, false);
  const before = await readFile(join(root, "state.json"));
  const entries = await readdir(root);
  await processForecast(input, {
    stateDirectory: root,
    now: NOW,
    preview: true,
    notifier: () => assert.fail("Preview delivered"),
  });
  assert.deepEqual(await readFile(join(root, "state.json")), before);
  assert.deepEqual(await readdir(root), entries);
  await processForecast(input, {
    stateDirectory: root,
    now: NOW,
    notifier: (title) => delivered.push(title),
  });
  await processForecast(input, {
    stateDirectory: root,
    now: NOW,
    notifier: () => assert.fail("Already delivered"),
  });
  assert.deepEqual(
    delivered.map((title) =>
      title.includes("session") ? "session" : "weekly",
    ),
    ["weekly", "session"],
  );
  assert.equal(
    (await stored(root)).windows["codex@fixture.session"].exhausted,
    true,
  );
});

test("invalid payloads create no storage and corrupt or ambiguous history is not replaced", async (t) => {
  const root = await sandbox(t);
  const absent = join(root, "absent");
  await assert.rejects(processForecast({}, { stateDirectory: absent }));
  await assert.rejects(stat(absent), { code: "ENOENT" });
  const path = join(root, "state.json");
  await writeFile(path, "{private-corrupt-fixture");
  for (const preview of [true, false]) {
    await assert.rejects(
      processForecast(payload(), { stateDirectory: root, now: NOW, preview }),
    );
    assert.equal(await readFile(path, "utf8"), "{private-corrupt-fixture");
  }
  const legacy = JSON.stringify({
    version: 1,
    windows: {
      "codex.weekly": {
        reset: NOW + 4 * 86_400,
        samples: [[NOW, 0.2]],
        pending: null,
        risk_alert: null,
        exhausted: false,
      },
    },
  });
  await writeFile(path, legacy);
  const multiple = payload();
  multiple.providers["codex@second"] = structuredClone(
    multiple.providers["codex@fixture"],
  );
  await assert.rejects(
    processForecast(multiple, { stateDirectory: root, now: NOW }),
  );
  assert.equal(await readFile(path, "utf8"), legacy);
});

test("the executable migration preserves every legacy version and successful flags without sampling", async (t) => {
  const root = await sandbox(t);
  const input = payload(1);
  input.providers["codex@second"] = structuredClone(
    input.providers["codex@fixture"],
  );
  const legacy = {
    reset: NOW + 4 * 86_400,
    samples: [[NOW - 60, 0.9]],
    pending: { since: NOW - 3600, count: 3 },
    risk_alert: { at: NOW - 30, overshoot: 0.2, early: 86_400 },
    exhausted: true,
    future: "retained",
  };
  for (const version of [1, 2, 3]) {
    const path = join(root, "state.json");
    const original = JSON.stringify({
      version,
      windows: { "codex.weekly": legacy },
    });
    await writeFile(path, original);
    assert.notEqual(await assign(root, input, ["codex=codex@missing"]), 0);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(await assign(root, input, ["codex=codex@fixture"]), 0);
    assert.deepEqual(await stored(root), {
      version: 3,
      windows: { "codex@fixture.weekly": legacy },
      legacy_bindings: { codex: "codex@fixture" },
    });
  }
});

test("simultaneous monitors deliver one exhaustion alert and retain one cached reading", async (t) => {
  const root = await sandbox(t);
  await Promise.all(
    Array.from({ length: 4 }, () =>
      execute(
        process.execPath,
        [worker, root, JSON.stringify(payload(1)), String(NOW)],
        { timeout: 10_000 },
      ),
    ),
  );
  assert.equal(
    await readFile(join(root, "delivered.log"), "utf8"),
    "delivered\n",
  );
  const item = (await stored(root)).windows["codex@fixture.weekly"];
  assert.equal(item.exhausted, true);
  assert.deepEqual(item.samples, [[NOW, 1]]);
});
