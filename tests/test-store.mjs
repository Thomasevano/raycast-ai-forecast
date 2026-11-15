import assert from "node:assert/strict";
import { spawn, fork } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readState, saveState, withStateLock } from "../src/forecast-store.ts";

const workerPath = fileURLToPath(
  new URL("./fixtures/store-worker.mjs", import.meta.url),
);
async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), "forecast-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function worker(dir, mode) {
  const child = fork(workerPath, [dir, mode], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exit = once(child, "exit");
  return { child, exit };
}
async function nativeAttempt(path) {
  const child = spawn(
    "/usr/bin/lockf",
    ["-k", "-s", "-t", "0", path, "/usr/bin/true"],
    { stdio: "ignore" },
  );
  const [code] = await once(child, "close");
  return code;
}

test("preview is read-only and corrupt history remains untouched", async (t) => {
  const root = await sandbox(t);
  const missing = join(root, "missing");
  assert.equal(await readState(missing), undefined);
  assert.deepEqual(await readdir(root), []);
  const path = join(root, "state.json");
  await writeFile(path, "{broken");
  await assert.rejects(readState(root), SyntaxError);
  assert.equal(await readFile(path, "utf8"), "{broken");
});

test("private atomic replacement rejects invalid numbers and unsafe symlinks", async (t) => {
  const root = await sandbox(t);
  await withStateLock(root, async () => saveState(root, { count: 1 }));
  const path = join(root, "state.json");
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "state.lock"))).mode & 0o777, 0o600);
  await assert.rejects(saveState(root, { nested: [Infinity] }));
  assert.deepEqual(await readState(root), { count: 1 });
  assert.deepEqual((await readdir(root)).sort(), ["state.json", "state.lock"]);
  await chmod(path, 0o644);
  await withStateLock(root, async () => {});
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const target = join(root, "target");
  await writeFile(target, "untouched");
  await rm(path);
  await symlink(target, path);
  await assert.rejects(readState(root));
  await assert.rejects(saveState(root, { count: 2 }));
  await assert.rejects(withStateLock(root, async () => {}));
  assert.equal(await readFile(target, "utf8"), "untouched");
});

test("separate processes serialize read-modify-write transactions", async (t) => {
  const root = await sandbox(t);
  const processes = Array.from({ length: 6 }, () => worker(root, "increment"));
  for (const process of processes) {
    const [code] = await process.exit;
    assert.equal(code, 0);
  }
  assert.deepEqual(await readState(root), { count: 6 });
});

test("native flock interoperates and releases after callback and process death", async (t) => {
  const root = await sandbox(t);
  const held = worker(root, "hold");
  t.after(() => held.child.kill("SIGKILL"));
  await once(held.child, "message");
  const lock = join(root, "state.lock");
  assert.equal(await nativeAttempt(lock), 75);
  held.child.send("release");
  assert.equal((await held.exit)[0], 0);
  assert.equal(await nativeAttempt(lock), 0);
  const killed = worker(root, "hold");
  t.after(() => killed.child.kill("SIGKILL"));
  await once(killed.child, "message");
  assert.equal(await nativeAttempt(lock), 75);
  killed.child.kill("SIGKILL");
  await killed.exit;
  assert.equal(await nativeAttempt(lock), 0);
});

test(
  "abort while waiting cannot run the operation or strand the lock",
  { timeout: 10_000 },
  async (t) => {
    const root = await sandbox(t);
    const missing = join(root, "absent");
    const already = AbortSignal.abort();
    await assert.rejects(withStateLock(missing, async () => {}, already));
    assert.deepEqual(await readdir(root), []);
    const held = worker(root, "hold");
    t.after(() => held.child.kill("SIGKILL"));
    await once(held.child, "message");
    const controller = new AbortController();
    let called = false;
    const waiting = withStateLock(
      root,
      async () => {
        called = true;
      },
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await assert.rejects(waiting);
    assert.equal(called, false);
    assert.equal(await nativeAttempt(join(root, "state.lock")), 75);
    held.child.send("release");
    await held.exit;
    await withStateLock(root, async () => {
      called = true;
    });
    assert.equal(called, true);
  },
);

test("aborting a running operation does not release its lock early", async (t) => {
  const root = await sandbox(t);
  const controller = new AbortController();
  let release;
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const running = withStateLock(
    root,
    async () => {
      entered();
      await gate;
    },
    controller.signal,
  );
  await ready;
  controller.abort();
  assert.equal(await nativeAttempt(join(root, "state.lock")), 75);
  release();
  await running;
  assert.equal(await nativeAttempt(join(root, "state.lock")), 0);
});
