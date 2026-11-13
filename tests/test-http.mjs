import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, mock } from "node:test";

// External discovery boundaries are isolated before the adapter is imported.
// Never execute an installed helper or read the developer's actual accounts.
mock.method(childProcess, "execFile", () =>
  assert.fail("Unexpected installed helper execution"),
);
mock.method(fs, "access", async () => {
  throw Object.assign(new Error("Fixture helper absent"), { code: "ENOENT" });
});
syncBuiltinESMExports();
const { readForecast, API_URL } = await import("../src/quota.ts");
after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

function payload() {
  const now = Date.now();
  return {
    schema: "openusage.limits.v1",
    providers: {
      codex: {
        fetchedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 600_000).toISOString(),
        resources: {
          weekly: {
            kind: "consumption",
            utilization: 0.2,
            resetsAt: new Date(now + 86_400_000).toISOString(),
            windowSeconds: 7 * 86_400,
          },
        },
      },
    },
  };
}
async function sandbox(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "forecast-http-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return join(root, "absent");
}

test("without an installed helper the local HTTP v1 snapshot remains usable", async (t) => {
  const stateDirectory = await sandbox(t);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, API_URL);
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify(payload()));
  });
  const result = await readForecast({ preview: true, stateDirectory });
  assert.deepEqual(
    result.windows.map(({ id }) => id),
    ["codex.weekly"],
  );
  await assert.rejects(fs.stat(stateDirectory), { code: "ENOENT" });
});

test("an oversized but valid HTTP snapshot cannot bypass the input bound", async (t) => {
  const stateDirectory = await sandbox(t);
  const input = { ...payload(), padding: "x".repeat(1024 * 1024) };
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify(input)),
  );
  await assert.rejects(readForecast({ preview: true, stateDirectory }));
  await assert.rejects(fs.stat(stateDirectory), { code: "ENOENT" });
});
