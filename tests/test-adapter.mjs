import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
async function helper(root, source, version = "0.8.0") {
  const path = join(root, "fixture helper; not a shell");
  await writeFile(
    path,
    `#!${process.execPath}\nif (process.argv[2] === "--version") { process.stdout.write(${JSON.stringify(`openusage ${version}\n`)}); } else {\n${source}\n}\n`,
    { mode: 0o700 },
  );
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

test("unchanged helper capability is cached across forecast reads", async (t) => {
  const root = await sandbox(t);
  const stateDirectory = join(root, "absent");
  const calls = join(root, "calls");
  const openusagePath = join(root, "openusage");
  const input = {
    schema: "openusage.limits.v2",
    providers: { "codex@fixture": provider() },
  };
  await writeFile(
    openusagePath,
    `#!${process.execPath}\nconst fs = require("node:fs"); if (process.argv[2] === "--version") { fs.appendFileSync(${JSON.stringify(calls)}, "version\\n"); process.stdout.write("openusage 0.8.0\\n"); } else { fs.appendFileSync(${JSON.stringify(calls)}, "usage\\n"); process.stdout.write(${JSON.stringify(JSON.stringify(input))}); }\n`,
    { mode: 0o700 },
  );
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("A cached-only helper must not switch to HTTP"),
  );
  for (let i = 0; i < 2; i++) {
    const result = await readForecast({
      openusagePath,
      stateDirectory,
      preview: true,
    });
    assert.deepEqual(
      result.windows.map(({ id }) => id),
      ["codex@fixture.weekly"],
    );
  }
  assert.equal(await readFile(calls, "utf8"), "version\nusage\nusage\n");
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
  openusagePath = await helper(root, "process.exitCode = 4;");
  await assert.rejects(
    readForecast({ openusagePath, stateDirectory, preview: true }),
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

test("a legacy helper uses HTTP without invoking its credential-reading usage command", async (t) => {
  const root = await sandbox(t);
  const stateDirectory = join(root, "absent");
  const touched = join(root, "usage-command-invoked");
  const input = {
    schema: "openusage.limits.v1",
    providers: {
      codex: provider(),
      "codex@ab12cd34": provider(),
    },
  };
  const openusagePath = await helper(
    root,
    `require("node:fs").writeFileSync(${JSON.stringify(touched)}, "unsafe refresh"); process.stdout.write(${JSON.stringify(JSON.stringify(input))});`,
    "0.7.16",
  );
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify(input)),
  );
  const result = await readForecast({
    openusagePath,
    stateDirectory,
    preview: true,
  });
  await assert.rejects(stat(touched), { code: "ENOENT" });
  assert.deepEqual(
    result.windows.map(({ id }) => id),
    ["codex.weekly", "codex@ab12cd34.weekly"],
  );
  await assert.rejects(stat(stateDirectory), { code: "ENOENT" });
});

test("replacing a cached-only helper with a legacy version cannot run its usage command", async (t) => {
  const root = await sandbox(t);
  const stateDirectory = join(root, "absent");
  const modern = {
    schema: "openusage.limits.v2",
    providers: { "codex@modern": provider() },
  };
  const openusagePath = await helper(
    root,
    `process.stdout.write(${JSON.stringify(JSON.stringify(modern))});`,
  );
  const first = await readForecast({
    openusagePath,
    stateDirectory,
    preview: true,
  });
  assert.deepEqual(
    first.windows.map(({ id }) => id),
    ["codex@modern.weekly"],
  );
  const touched = join(root, "unsafe-legacy-refresh");
  const update = await mkdtemp(join(root, "update-"));
  const replacement = await helper(
    update,
    `require("node:fs").writeFileSync(${JSON.stringify(touched)}, "unsafe refresh"); process.exit(2);`,
    "0.7.16",
  );
  await rename(replacement, openusagePath);
  const legacy = {
    schema: "openusage.limits.v1",
    providers: { "codex@ab12cd34": provider() },
  };
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify(legacy)),
  );
  const second = await readForecast({
    openusagePath,
    stateDirectory,
    preview: true,
  });
  await assert.rejects(stat(touched), { code: "ENOENT" });
  assert.deepEqual(
    second.windows.map(({ id }) => id),
    ["codex@ab12cd34.weekly"],
  );
  await assert.rejects(stat(stateDirectory), { code: "ENOENT" });
});

test("helper replacement during a version probe fails closed before usage", async (t) => {
  const root = await sandbox(t);
  const stateDirectory = join(root, "absent");
  const touched = join(root, "unsafe-legacy-refresh");
  const update = await mkdtemp(join(root, "update-"));
  const replacement = await helper(
    update,
    `require("node:fs").writeFileSync(${JSON.stringify(touched)}, "unsafe refresh"); process.exit(2);`,
    "0.7.16",
  );
  const openusagePath = join(root, "openusage");
  await writeFile(
    openusagePath,
    `#!${process.execPath}\nif (process.argv[2] === "--version") { require("node:fs").renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(openusagePath)}); process.stdout.write("openusage 0.8.0\\n"); } else { process.exit(2); }\n`,
    { mode: 0o700 },
  );
  await assert.rejects(
    readForecast({ openusagePath, stateDirectory, preview: true }),
    (error) => !error.message.includes(root),
  );
  await assert.rejects(stat(touched), { code: "ENOENT" });
  await assert.rejects(stat(stateDirectory), { code: "ENOENT" });
});

test("an unidentified helper cannot run usage or silently switch to HTTP", async (t) => {
  const root = await sandbox(t);
  const stateDirectory = join(root, "absent");
  const usage = join(root, "unsafe-usage");
  const http = join(root, "unexpected-http");
  const openusagePath = await helper(
    root,
    `require("node:fs").writeFileSync(${JSON.stringify(usage)}, "unsafe refresh"); process.exit(2);`,
    "development-fixture",
  );
  t.mock.method(globalThis, "fetch", async () => {
    await writeFile(http, "unexpected request");
    return new Response("{}");
  });
  await assert.rejects(
    readForecast({ openusagePath, stateDirectory, preview: true }),
    (error) => !error.message.includes(root),
  );
  await assert.rejects(stat(usage), { code: "ENOENT" });
  await assert.rejects(stat(http), { code: "ENOENT" });
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
