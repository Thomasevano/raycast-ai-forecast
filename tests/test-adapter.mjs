import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readForecast } from "../src/quota.ts";

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), "forecast-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function provider() {
  const now = Date.now();
  return {
    fetchedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
    resources: {
      weekly: {
        kind: "consumption",
        utilization: 0.2,
        resetsAt: new Date(now + 4 * 86_400_000).toISOString(),
        windowSeconds: 7 * 86_400,
      },
    },
  };
}
async function helper(root, source) {
  const path = join(root, "fixture helper; not a shell");
  await writeFile(path, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  return path;
}

test("a trusted helper path with spaces executes cached v2 and v1 snapshots directly", async (t) => {
  const root = await sandbox(t);
  const stateDirectory = join(root, "absent");
  for (const [schema, key] of [
    ["openusage.limits.v2", "codex@fixture"],
    ["openusage.limits.v1", "codex"],
  ]) {
    const input = { schema, providers: { [key]: provider() } };
    const openusagePath = await helper(
      root,
      `process.stdout.write(${JSON.stringify(JSON.stringify(input))});`,
    );
    const result = await readForecast({
      openusagePath,
      stateDirectory,
      preview: true,
    });
    assert.deepEqual(
      result.windows.map(({ id }) => id),
      [`${key}.weekly`],
    );
  }
  await assert.rejects(stat(stateDirectory), { code: "ENOENT" });
});

test("helper exit four hides disconnected accounts and helper failures never fall back or expose stderr", async (t) => {
  const root = await sandbox(t);
  const stateDirectory = join(root, "absent");
  let openusagePath = await helper(
    root,
    `process.stdout.write('{"schema":"openusage.limits.v2","providers":{}}'); process.exitCode = 4;`,
  );
  assert.deepEqual(
    (await readForecast({ openusagePath, stateDirectory, preview: true }))
      .windows,
    [],
  );
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("A failing installed helper must not switch to HTTP"),
  );
  openusagePath = await helper(
    root,
    `process.stderr.write("private-fixture-token"); process.exitCode = 2;`,
  );
  await assert.rejects(
    readForecast({ openusagePath, stateDirectory, preview: true }),
    (error) =>
      !error.message.includes("private-fixture-token") &&
      !error.message.includes(root),
  );
  await assert.rejects(stat(stateDirectory), { code: "ENOENT" });
});

test("oversized helper output is rejected before creating state", async (t) => {
  const root = await sandbox(t);
  const stateDirectory = join(root, "absent");
  const input = {
    schema: "openusage.limits.v2",
    providers: { "codex@fixture": provider() },
  };
  const openusagePath = await helper(
    root,
    `const input = ${JSON.stringify(input)}; input.padding = "x".repeat(1024 * 1024); process.stdout.write(JSON.stringify(input));`,
  );
  await assert.rejects(
    readForecast({ openusagePath, stateDirectory, preview: true }),
  );
  await assert.rejects(stat(stateDirectory), { code: "ENOENT" });
});

test(
  "cancellation terminates a running helper without creating history",
  { timeout: 10_000 },
  async (t) => {
    const root = await sandbox(t);
    const stateDirectory = join(root, "absent");
    const ready = join(root, "ready");
    const openusagePath = await helper(
      root,
      `const { writeFileSync } = await import("node:fs"); writeFileSync(${JSON.stringify(ready)}, "ready"); setTimeout(() => {}, 30_000);`,
    );
    const controller = new AbortController();
    const pending = readForecast({
      openusagePath,
      stateDirectory,
      preview: false,
      signal: controller.signal,
    });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    try {
      const deadline = Date.now() + 2000;
      while (true) {
        try {
          await readFile(ready);
          break;
        } catch (error) {
          if (error.code !== "ENOENT" || Date.now() > deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    } finally {
      controller.abort();
    }
    await rejected;
    await assert.rejects(stat(stateDirectory), { code: "ENOENT" });
  },
);
