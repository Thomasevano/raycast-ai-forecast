import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function aborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export async function readState(
  directory: string,
): Promise<unknown | undefined> {
  let file;
  try {
    file = await open(
      join(directory, "state.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    if (!(await file.stat()).isFile())
      throw new Error("State file must be a regular file");
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

export async function saveState(
  directory: string,
  state: object,
): Promise<void> {
  const json = JSON.stringify(state, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("State contains a non-finite number");
    }
    return value;
  });
  if (json === undefined) throw new TypeError("State is not serializable");
  const destination = join(directory, "state.json");
  try {
    if ((await lstat(destination)).isSymbolicLink())
      throw new Error("State file must not be a symbolic link");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(directory, `.state-${randomUUID()}`);
  let created = false;
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await file.chmod(0o600);
      await file.writeFile(json, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
    created = false;
    const dir = await open(directory, constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    if (created)
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}

async function tryAcquire(
  fd: number,
  timeout: number,
  signal?: AbortSignal,
): Promise<boolean> {
  aborted(signal);
  const child = spawn("/usr/bin/lockf", ["-s", "-t", "0", "3"], {
    stdio: ["ignore", "ignore", "pipe", fd],
  });
  let failure: Error | undefined;
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  const cancel = () => {
    child.kill("SIGKILL");
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => {
    failure = new Error("Timed out acquiring state lock");
    child.kill("SIGKILL");
  }, timeout);
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.on("error", (error) => {
        failure = error;
      });
      child.on("close", resolve);
    });
    aborted(signal);
    if (failure) throw failure;
    if (code === 75) return false; // EX_TEMPFAIL: another process owns the lock.
    if (code !== 0)
      throw new Error(
        `Could not acquire state lock${stderr ? `: ${stderr.trim()}` : ""}`,
      );
    return true;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

async function acquire(fd: number, signal?: AbortSignal): Promise<void> {
  const deadline = performance.now() + 30_000;
  for (;;) {
    aborted(signal);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Timed out acquiring state lock");
    if (await tryAcquire(fd, remaining, signal)) return;
    // Apple's descriptor mode busy-spins with -t > 0; wait in Node instead.
    await delay(
      Math.min(100, Math.max(0, deadline - performance.now())),
      undefined,
      {
        signal,
      },
    );
  }
}

export async function withStateLock<T>(
  directory: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  aborted(signal);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  aborted(signal);
  await chmod(directory, 0o700);
  aborted(signal);
  const file = await open(
    join(directory, "state.lock"),
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    if (!(await file.stat()).isFile())
      throw new Error("Lock file must be a regular file");
    await file.chmod(0o600);
    aborted(signal);
    await acquire(file.fd, signal);
    aborted(signal);
    // Tighten an existing history file without following a leaf symlink.
    let existing;
    try {
      existing = await open(
        join(directory, "state.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      try {
        if (!(await existing.stat()).isFile())
          throw new Error("State file must be a regular file");
        await existing.chmod(0o600);
      } finally {
        await existing.close();
      }
    }
    aborted(signal);
    return await operation();
  } finally {
    await file.close();
  }
}
