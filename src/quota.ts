import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const STATE_DIRECTORY = join(
  homedir(),
  "Library",
  "Application Support",
  "AI Forecast",
);
export const API_URL = "http://127.0.0.1:6736/v1/limits";
const NOTIFICATION_SCRIPT =
  "on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run";

export type Severity = "normal" | "yellow" | "red" | "unavailable";
export interface QuotaWindow {
  id: string;
  accountId: string;
  provider: string;
  providerName: string;
  plan: string;
  title: string;
  meter: string;
  reset: string;
  severity: Severity;
  forecast?: { summary: string; detail: string; severity: Severity };
}
export interface Snapshot {
  windows: QuotaWindow[];
  status: string;
  severity: Severity;
}
export type ResetSource = "codex-reset.com" | "willcodexquotareset.com";
export interface Outlook {
  source: ResetSource;
  available: boolean;
  day?: number;
  twoDays?: number;
  signalScore?: number;
  updatedAt?: string;
  note?: string;
}
interface EngineOptions {
  pythonPath?: string;
  openusagePath?: string;
  assetsPath: string;
  preview: boolean;
  signal?: AbortSignal;
  stateDirectory?: string;
}

function severity(value: string): Severity {
  return value === "yellow" || value === "red" || value === "unavailable"
    ? value
    : "normal";
}

function parseRows(output: string): Snapshot {
  const rows = output
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
  const providers = new Map(
    rows
      .filter((row) => row[0] === "provider" && row[6] === "on")
      .map((row) => [row[1], row]),
  );
  const forecasts = new Map(
    rows
      .filter((row) => row[0] === "forecast" && row[6] === "on")
      .map((row) => [row[1], row]),
  );
  const status = rows.find((row) => row[0] === "status");
  if (!status || rows[0]?.[0] !== "summary")
    throw new Error("The forecast engine returned an invalid response.");
  const windows: QuotaWindow[] = [];
  for (const row of rows) {
    if (row[0] !== "resource" || row[6] !== "on") continue;
    const accountId = row[1].split(".")[0];
    const provider = accountId.split("@")[0];
    const source = providers.get(accountId);
    if (!source) continue;
    const projection = forecasts.get(row[1]);
    windows.push({
      id: row[1],
      accountId,
      provider,
      providerName: source[2],
      plan: source[3],
      title: row[2],
      meter: row[3],
      reset: row[4],
      severity: severity(row[5]),
      forecast: projection
        ? {
            summary: projection[3],
            detail: projection[4],
            severity: severity(projection[5]),
          }
        : undefined,
    });
  }
  return { windows, status: status[1], severity: severity(status[2]) };
}

async function findExecutable(
  name: string,
  directories: string[],
): Promise<string | undefined> {
  for (const directory of [
    ...directories,
    ...(process.env.PATH ?? "").split(":"),
  ]) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    if (candidate === "/usr/bin/python3") continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES")
        throw error;
    }
  }
}

async function readSnapshot(
  openusagePath?: string,
  signal?: AbortSignal,
): Promise<string> {
  const cli =
    openusagePath?.trim() ||
    (await findExecutable("openusage", [
      "/usr/local/bin",
      "/opt/homebrew/bin",
    ]));
  if (cli) {
    try {
      const { stdout } = await execute(cli, [], {
        timeout: 2500,
        maxBuffer: 1024 * 1024,
        signal,
      });
      return stdout;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === 4 &&
        "stdout" in error &&
        typeof error.stdout === "string"
      )
        return error.stdout;
      throw new Error(
        "OpenUsage's command-line helper could not read its cached snapshot. Keep OpenUsage running and check the helper path in extension preferences.",
      );
    }
  }
  try {
    const boundedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(2500)])
      : AbortSignal.timeout(2500);
    const response = await fetch(API_URL, {
      signal: boundedSignal,
      redirect: "error",
    });
    if (!response.ok) throw new Error("Snapshot unavailable");
    return await response.text();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      "OpenUsage is unavailable. In OpenUsage 0.8 or newer, install the command-line helper from Settings → Advanced → Command Line. Older 0.7.x releases can use the local HTTP API.",
    );
  }
}

export async function readForecast(options: EngineOptions): Promise<Snapshot> {
  const pythonPath =
    options.pythonPath?.trim() ||
    (await findExecutable("python3", [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/Library/Developer/CommandLineTools/usr/bin",
    ]));
  if (!pythonPath)
    throw new Error(
      "Python 3 was not found. Install Python 3 or set the optional interpreter override in extension preferences.",
    );
  const payload = await readSnapshot(options.openusagePath, options.signal);
  const args = [
    join(options.assetsPath, "openusage-model.py"),
    "--state-dir",
    options.stateDirectory ?? STATE_DIRECTORY,
  ];
  if (options.preview) args.push("--preview");
  try {
    const execution = execute(pythonPath, args, {
      timeout: options.preview ? 5000 : 45000,
      maxBuffer: 1024 * 1024,
      signal: options.signal,
    });
    const [, { stdout }] = await Promise.all([
      execution.child.stdin
        ? pipeline(Readable.from([payload]), execution.child.stdin)
        : Promise.resolve(),
      execution,
    ]);
    return parseRows(stdout);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT")
      throw new Error(
        "Python 3 could not be started. Check the Python executable in extension preferences.",
      );
    if (
      error &&
      typeof error === "object" &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.startsWith("OpenUsage: Ambiguous legacy history")
    ) {
      throw new Error(
        "Previous quota history matches multiple accounts. Follow the README's legacy-account migration instructions before monitoring; history has not been discarded.",
      );
    }
    throw new Error(
      "The forecast engine could not read the snapshot or saved history. Check Python and history permissions; do not reset your history.",
    );
  }
}

const OUTLOOK_SOURCES: Record<ResetSource, { url: string; note: string }> = {
  "codex-reset.com": {
    url: "https://codex-reset.com/",
    note: "Experimental global-reset forecast. The website's homepage can show a different combined global-or-banked outlook.",
  },
  "willcodexquotareset.com": {
    url: "https://www.willcodexquotareset.com/",
    note: "Uncalibrated 48-hour signal score, not a personal quota reset.",
  },
};

function freshTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    return false;
  }
  const time = Date.parse(value);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    return false;
  }
  const age = Date.now() - time;
  return age >= 0 && age <= 3_600_000;
}

function isPercent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
  );
}

interface OutlookCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

const memoryOutlooks = new Map<string, string>();

async function cachedOutlook(
  source: ResetSource,
  signal: AbortSignal | undefined,
  cache: OutlookCache,
): Promise<Outlook> {
  const unavailable: Outlook = {
    source,
    available: false,
    note: OUTLOOK_SOURCES[source].note,
  };
  if (signal?.aborted) return unavailable;
  const requestedAt = Date.now();
  try {
    const saved = cache.get(source);
    if (saved) {
      try {
        const entry = JSON.parse(saved) as {
          requestedAt: number;
          until: number;
          value: Outlook;
        };
        if (
          Number.isFinite(entry.requestedAt) &&
          Number.isFinite(entry.until) &&
          entry.requestedAt <= requestedAt &&
          requestedAt < entry.until
        ) {
          const value = entry.value;
          const valid =
            value?.source === source &&
            value.available === true &&
            freshTimestamp(value.updatedAt) &&
            (source === "codex-reset.com"
              ? isPercent(value.day) &&
                isPercent(value.twoDays) &&
                value.day <= value.twoDays
              : isPercent(value.signalScore));
          return valid ? value : unavailable;
        }
      } catch {
        // Only this disposable public-data cache is replaced, never quota history.
      }
    }
    let until = requestedAt + 60_000;
    cache.set(
      source,
      JSON.stringify({ requestedAt, until, value: unavailable }),
    );
    const value = await fetchOutlook(source, signal, (retryAt) => {
      until = Math.max(until, retryAt);
    });
    cache.set(source, JSON.stringify({ requestedAt, until, value }));
    return value;
  } catch {
    return unavailable;
  }
}

async function fetchOutlook(
  source: ResetSource,
  signal: AbortSignal | undefined,
  deferRetry: (until: number) => void,
): Promise<Outlook> {
  const { url, note } = OUTLOOK_SOURCES[source];
  const unavailable: Outlook = { source, available: false, note };
  try {
    const boundedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(2500)])
      : AbortSignal.timeout(2500);
    const response = await fetch(`${url}api/forecast`, {
      signal: boundedSignal,
      redirect: "error",
      headers: {
        Accept: "application/json",
        "User-Agent":
          "AI-Forecast (+https://github.com/Thomasevano/raycast-ai-forecast)",
      },
    });
    if (response.status === 429) {
      const retry = response.headers.get("Retry-After");
      if (retry) {
        const retryAt = /^\d+$/.test(retry)
          ? Date.now() + Number(retry) * 1000
          : Date.parse(retry);
        if (Number.isFinite(retryAt)) deferRetry(retryAt);
      }
    }
    if (!response.ok) return unavailable;
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null || Array.isArray(data))
      return unavailable;

    if (source === "codex-reset.com") {
      if (
        !("updated_at" in data) ||
        !freshTimestamp(data.updated_at) ||
        !("probabilities" in data)
      )
        return unavailable;
      const probabilities = data.probabilities;
      if (
        typeof probabilities !== "object" ||
        probabilities === null ||
        !("rounded_24h" in probabilities) ||
        !("rounded_48h" in probabilities)
      )
        return unavailable;
      const day = probabilities.rounded_24h;
      const twoDays = probabilities.rounded_48h;
      if (!isPercent(day) || !isPercent(twoDays) || day > twoDays)
        return unavailable;
      return {
        source,
        available: true,
        day,
        twoDays,
        updatedAt: data.updated_at,
        note,
      };
    }

    if (
      !("fetchedAt" in data) ||
      !freshTimestamp(data.fetchedAt) ||
      !("forecast" in data)
    )
      return unavailable;
    const forecast = data.forecast;
    if (
      typeof forecast !== "object" ||
      forecast === null ||
      !("horizonHours" in forecast) ||
      !("score" in forecast) ||
      !("calibrated" in forecast) ||
      forecast.calibrated !== false ||
      forecast.horizonHours !== 48 ||
      !isPercent(forecast.score)
    )
      return unavailable;
    const errors = "sourceErrors" in data ? data.sourceErrors : undefined;
    const degraded =
      typeof errors === "object" &&
      errors !== null &&
      Object.keys(errors).length > 0;
    return {
      source,
      available: true,
      signalScore: forecast.score,
      updatedAt: data.fetchedAt,
      note: degraded ? `${note} The source reports incomplete signals.` : note,
    };
  } catch {
    return unavailable;
  }
}

export async function readOutlooks(
  signal?: AbortSignal,
  cache: OutlookCache = memoryOutlooks,
): Promise<Outlook[]> {
  return Promise.all([
    cachedOutlook("codex-reset.com", signal, cache),
    cachedOutlook("willcodexquotareset.com", signal, cache),
  ]);
}

export async function openOpenUsage(): Promise<void> {
  await execute("/usr/bin/open", ["-g", "-a", "OpenUsage"], { timeout: 5000 });
}

export async function openOutlook(source: ResetSource): Promise<void> {
  await execute("/usr/bin/open", ["-g", OUTLOOK_SOURCES[source].url], {
    timeout: 5000,
  });
}

export async function sendTestNotification(): Promise<void> {
  await execute(
    "/usr/bin/osascript",
    [
      "-e",
      NOTIFICATION_SCRIPT,
      "AI Forecast",
      "Notification test — quota monitoring only alerts on sustained risk or exhaustion.",
    ],
    { timeout: 10000 },
  );
}
