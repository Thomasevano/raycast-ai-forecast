import { createHash } from "node:crypto";
import type {
  Cycle,
  ForecastState,
  Notifier,
  ProviderKind,
  QuotaWindow,
  Sample,
  Severity,
  Snapshot,
  SourceProvider,
  SourceSnapshot,
  WindowKind,
  WindowMetadata,
} from "./forecast-types.ts";

const HOUR = 3600,
  DAY = 86400,
  MAX_SAMPLES = 2048,
  MAX_CYCLES = 4,
  DASH = "—";
const kinds: ProviderKind[] = ["claude", "codex"];
const windows: WindowKind[] = ["weekly", "session"];
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const number = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const accountKind = (v: unknown): ProviderKind | undefined =>
  typeof v === "string"
    ? (/^(claude|codex)@[A-Za-z0-9_-]{1,128}$/.exec(v)?.[1] as
        ProviderKind | undefined)
    : undefined;
const confidenceSpan = (kind: WindowKind, window: number) =>
  kind === "weekly" ? 6 * HOUR : Math.min(HOUR, window / 4);
const timestamp = (v: unknown): number | undefined => {
  if (typeof v !== "string") return undefined;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(Z|[+-]\d{2}:\d{2})$/i.exec(
      v,
    );
  if (!parts) return undefined;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText = "00",
    fraction = "",
    zone,
  ] = parts;
  const year = Number(yearText),
    month = Number(monthText),
    day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days =
    month === 2
      ? leap
        ? 29
        : 28
      : month === 4 || month === 6 || month === 9 || month === 11
        ? 30
        : 31;
  if (
    !year ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days ||
    Number(hourText) > 23 ||
    Number(minuteText) > 59 ||
    Number(secondText) > 59
  )
    return undefined;
  const t = Date.parse(
    `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${zone}`,
  );
  return Number.isFinite(t)
    ? t / 1000 + Number(`0.${fraction.slice(0, 6) || "0"}`)
    : undefined;
};
const clean = (v: unknown): string =>
  typeof v === "string"
    ? v
        .replace(/\p{Cc}/gu, " ")
        .trim()
        .split(/\s+/u)
        .join(" ")
        .slice(0, 64) || DASH
    : DASH;
function duration(seconds: number): string {
  if (seconds < HOUR) return `${Math.max(1, Math.ceil(seconds / 60))}m`;
  if (seconds < DAY) return `${Math.ceil(seconds / HOUR)}h`;
  const hours = Math.ceil(seconds / HOUR),
    days = Math.floor(hours / 24),
    remainder = hours % 24;
  return remainder ? `${days}d ${remainder}h` : `${days}d`;
}

export function parseSnapshot(input: unknown): SourceSnapshot {
  if (
    !record(input) ||
    (input.schema !== "openusage.limits.v1" &&
      input.schema !== "openusage.limits.v2") ||
    !record(input.providers) ||
    ("errors" in input && !Array.isArray(input.errors))
  )
    throw new Error("Invalid OpenUsage limits payload");
  const providers: SourceProvider[] = [];
  if (input.schema === "openusage.limits.v1") {
    for (const kind of kinds)
      providers.push({
        kind,
        accountId: kind,
        data: record(input.providers[kind]) ? input.providers[kind] : undefined,
      });
  } else {
    for (const [accountId, data] of Object.entries(input.providers)) {
      const kind = accountKind(accountId);
      if (kind) {
        if (!record(data)) throw new Error("Invalid OpenUsage account payload");
        providers.push({ kind, accountId, data });
      } else if (kinds.includes(accountId.split("@")[0] as ProviderKind))
        throw new Error("Invalid OpenUsage account identifier");
    }
  }
  return {
    schema: input.schema,
    providers,
    partial: Array.isArray(input.errors) && input.errors.length > 0,
  };
}

export function validateState(input: unknown): asserts input is ForecastState {
  if (
    !record(input) ||
    ![1, 2, 3].includes(input.version as number) ||
    !record(input.windows)
  )
    throw new Error("Invalid OpenUsage state");
  const bindings =
    input.legacy_bindings === undefined ? {} : input.legacy_bindings;
  if (
    !record(bindings) ||
    Object.entries(bindings).some(
      ([kind, account]) =>
        !kinds.includes(kind as ProviderKind) || accountKind(account) !== kind,
    )
  )
    throw new Error("Invalid OpenUsage legacy bindings");
  for (const [key, item] of Object.entries(input.windows)) {
    const separator = key.lastIndexOf("."),
      account = key.slice(0, separator),
      kind = key.slice(separator + 1) as WindowKind;
    if (
      separator < 0 ||
      !windows.includes(kind) ||
      (!kinds.includes(account as ProviderKind) && !accountKind(account)) ||
      !record(item)
    )
      throw new Error("Invalid OpenUsage window state");
    if (
      !["reset", "samples", "pending", "risk_alert", "exhausted"].every((k) =>
        Object.hasOwn(item, k),
      ) ||
      !number(item.reset) ||
      typeof item.exhausted !== "boolean"
    )
      throw new Error("Incomplete OpenUsage window state");
    const validSamples = (samples: unknown) => {
      if (!Array.isArray(samples) || samples.length > MAX_SAMPLES) return false;
      let previous = -Infinity;
      for (const sample of samples) {
        if (
          !Array.isArray(sample) ||
          sample.length !== 2 ||
          !number(sample[0]) ||
          !number(sample[1]) ||
          sample[1] < 0 ||
          sample[0] <= previous
        )
          return false;
        previous = sample[0];
      }
      return true;
    };
    if (
      !validSamples(item.samples) ||
      !validSamples(
        item.legacy_samples === undefined ? [] : item.legacy_samples,
      )
    )
      throw new Error("Invalid OpenUsage samples");
    if (
      item.pending !== null &&
      (!record(item.pending) ||
        !number(item.pending.since) ||
        !Number.isInteger(item.pending.count) ||
        (item.pending.count as number) < 1)
    )
      throw new Error("Invalid OpenUsage pending alert");
    if (
      item.risk_alert !== null &&
      (!record(item.risk_alert) ||
        ![
          item.risk_alert.at,
          item.risk_alert.overshoot,
          item.risk_alert.early,
        ].every(number))
    )
      throw new Error("Invalid OpenUsage alert");
    const metadata = item.metadata;
    if (
      metadata != null &&
      (!record(metadata) ||
        !number(metadata.window) ||
        metadata.window <= 0 ||
        typeof metadata.plan !== "string" ||
        !/^[0-9a-f]{64}$/.test(metadata.plan))
    )
      throw new Error("Invalid OpenUsage window metadata");
    const cycles = item.cycles === undefined ? [] : item.cycles;
    if (!Array.isArray(cycles) || cycles.length > MAX_CYCLES)
      throw new Error("Invalid OpenUsage cycle history");
    let lastReset = -Infinity;
    for (const cycle of cycles) {
      if (
        !record(metadata) ||
        !number(metadata.window) ||
        !record(cycle) ||
        !number(cycle.reset) ||
        !number(cycle.rate) ||
        !number(cycle.span) ||
        cycle.rate < 0 ||
        cycle.span < confidenceSpan(kind, metadata.window) ||
        !Number.isInteger(cycle.readings) ||
        (cycle.readings as number) < 3 ||
        cycle.reset >= item.reset ||
        cycle.reset <= lastReset
      )
        throw new Error("Invalid OpenUsage cycle");
      lastReset = cycle.reset;
    }
  }
}

export function migrateState(
  state: ForecastState,
  providers: SourceProvider[],
  assignments?: readonly string[],
): void {
  const bindings = state.legacy_bindings ?? {};
  const accounts = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      providers
        .filter((p) => p.kind === kind && p.accountId !== kind)
        .map((p) => p.accountId),
    ]),
  ) as Record<ProviderKind, string[]>;
  const choices: Partial<Record<ProviderKind, string>> = {};
  if (assignments !== undefined) {
    for (const assignment of assignments) {
      const match =
        typeof assignment === "string"
          ? /^(claude|codex)=(.*)$/.exec(assignment)
          : null;
      if (!match) throw new Error("Invalid legacy assignment");
      const kind = match[1] as ProviderKind,
        account = match[2];
      if (
        choices[kind] ||
        accountKind(account) !== kind ||
        !accounts[kind].includes(account)
      )
        throw new Error("Invalid legacy assignment");
      if (bindings[kind]) throw new Error("Legacy provider already bound");
      choices[kind] = account;
    }
  } else {
    for (const kind of kinds) {
      const legacy = windows.some((window) =>
        Object.hasOwn(state.windows, `${kind}.${window}`),
      );
      if (!bindings[kind] && legacy && accounts[kind].length > 1)
        throw new Error(
          "Ambiguous legacy history: assign the account explicitly",
        );
      if (!bindings[kind] && accounts[kind].length === 1)
        choices[kind] = accounts[kind][0];
    }
  }
  for (const kind of kinds) {
    const account = choices[kind];
    if (
      account &&
      windows.some(
        (window) =>
          Object.hasOwn(state.windows, `${kind}.${window}`) &&
          Object.hasOwn(state.windows, `${account}.${window}`),
      )
    )
      throw new Error("Legacy history destination collision");
  }
  for (const kind of kinds) {
    const account = choices[kind];
    if (!account) continue;
    for (const window of windows) {
      const source = `${kind}.${window}`,
        target = `${account}.${window}`;
      if (Object.hasOwn(state.windows, source)) {
        state.windows[target] = state.windows[source];
        delete state.windows[source];
      }
    }
    bindings[kind] = account;
  }
  state.legacy_bindings = bindings;
  state.version = 3;
}

type Forecast = {
  available: number;
  rate: number | null;
  ready: boolean;
  prior: boolean;
  span: number;
  required: number;
  readings: number;
  overshoot: number;
  early: number;
  reduction: number;
};
function forecast(
  samples: Sample[],
  used: number,
  fetched: number,
  reset: number,
  window: number,
  kind: WindowKind,
  cycles: Cycle[] = [],
): Forecast | undefined {
  const elapsed = fetched - (reset - window);
  if (
    elapsed <= 0 ||
    elapsed > window ||
    !samples.length ||
    samples[0][0] < reset - window
  )
    return undefined;
  const span = samples[samples.length - 1][0] - samples[0][0],
    required = confidenceSpan(kind, window),
    ready = samples.length >= 3 && span >= required;
  const prior = cycles.length
    ? cycles.reduce((sum, cycle) => sum + cycle.rate, 0) / cycles.length
    : null;
  const currentRate = ready
    ? (used / elapsed + Math.max(0, (used - samples[0][1]) / span)) / 2
    : null;
  const rate =
    currentRate !== null
      ? prior !== null
        ? currentRate * 0.75 + prior * 0.25
        : currentRate
      : prior;
  const remaining = Math.max(0, 1 - used),
    available =
      remaining / ((reset - fetched) / (kind === "weekly" ? DAY : HOUR));
  return {
    available,
    rate,
    ready,
    prior: prior !== null,
    span,
    required,
    readings: samples.length,
    overshoot: rate === null ? 0 : used + rate * (reset - fetched) - 1,
    early:
      rate !== null && rate > 0
        ? Math.max(0, reset - fetched - remaining / rate)
        : 0,
    reduction:
      rate !== null && rate > 0
        ? Math.max(0, 1 - remaining / (reset - fetched) / rate)
        : 0,
  };
}
const sameMetadata = (
  a: WindowMetadata | null | undefined,
  b: WindowMetadata | null,
): boolean =>
  a == null
    ? b === null
    : b !== null && a.window === b.window && a.plan === b.plan;

export async function renderForecast(
  snapshot: SourceSnapshot,
  state: ForecastState,
  now: number,
  notifier: Notifier,
  commit: () => Promise<void>,
): Promise<Snapshot> {
  const output: QuotaWindow[] = [],
    fetchedTimes: number[] = [];
  let staleAny = false,
    found = false;
  for (const {
    kind: providerKind,
    accountId: name,
    data: provider,
  } of snapshot.providers) {
    let title = providerKind === "claude" ? "Claude" : "Codex";
    if (
      name !== providerKind &&
      provider &&
      clean(provider.displayName) !== DASH
    )
      title = clean(provider.displayName);
    const stateAccount =
      name === providerKind
        ? (state.legacy_bindings?.[providerKind] ?? name)
        : name;
    if (!provider) continue;
    const fetched = timestamp(provider.fetchedAt),
      expiry = timestamp(provider.expiresAt);
    const fresh =
      provider.stale !== true &&
      fetched !== undefined &&
      fetched <= now &&
      (expiry !== undefined
        ? expiry > now
        : provider.expiresAt == null && now - fetched <= 900);
    staleAny ||= !fresh;
    if (fresh && fetched !== undefined) fetchedTimes.push(fetched);
    let plan = clean(provider.plan);
    if (!fresh) plan = plan === DASH ? "Stale" : `Stale · ${plan}`;
    const resources = record(provider.resources) ? provider.resources : {};
    for (const kind of windows) {
      const resource = resources[kind];
      if (
        !record(resource) ||
        resource.kind !== "consumption" ||
        !number(resource.utilization) ||
        resource.utilization < 0
      )
        continue;
      found = true;
      const used = resource.utilization,
        reset = timestamp(resource.resetsAt),
        window = resource.windowSeconds;
      const validWindow = number(window) && window > 0;
      const metadata: WindowMetadata | null =
        validWindow && typeof provider.plan === "string" && provider.plan.trim()
          ? {
              window,
              plan: createHash("sha256")
                .update(provider.plan.trim(), "utf8")
                .digest("hex"),
            }
          : null;
      let usable =
        fresh &&
        fetched !== undefined &&
        reset !== undefined &&
        reset > now &&
        fetched < reset;
      let item = state.windows[`${stateAccount}.${kind}`];
      const changedProfile =
        !!item &&
        metadata !== null &&
        item.metadata != null &&
        !sameMetadata(item.metadata, metadata);
      if (
        usable &&
        item?.samples.length &&
        fetched !== undefined &&
        reset !== undefined
      ) {
        const last = item.samples[item.samples.length - 1];
        if (
          fetched < last[0] ||
          (fetched === last[0] && (item.reset !== reset || last[1] !== used)) ||
          (reset < item.reset && !(changedProfile && fetched > last[0]))
        )
          usable = false;
      }
      const resetText =
        reset === undefined
          ? "Reset unknown"
          : reset <= now
            ? "Awaiting reset"
            : `Resets in ${duration(reset - now)}`;
      const filled = Math.floor(Math.min(1, used) * 8 + 0.5);
      const row: QuotaWindow = {
        id: `${name}.${kind}`,
        accountId: name,
        provider: providerKind,
        providerName: title,
        plan,
        title: kind === "weekly" ? "Weekly" : "Session",
        meter: `${"▰".repeat(filled)}${"▱".repeat(8 - filled)} ${(used * 100).toFixed(0)}%`,
        reset: resetText,
        severity: !usable ? "unavailable" : used >= 1 ? "red" : "normal",
      };
      let result: Forecast | undefined,
        newSample = false;
      if (usable && fetched !== undefined && reset !== undefined) {
        const last = item?.samples[item.samples.length - 1];
        const counterDropped =
          !!item &&
          item.reset === reset &&
          !!last &&
          fetched > last[0] &&
          last[1] - used > 0.01 + 1e-12;
        if (!item || item.reset !== reset) {
          let cycles: Cycle[] = [];
          if (
            item &&
            metadata !== null &&
            sameMetadata(item.metadata, metadata)
          ) {
            cycles = [...(item.cycles ?? [])];
            const oldSamples = item.samples;
            if (
              oldSamples.length &&
              fetched >= item.reset &&
              validWindow &&
              reset - window >= item.reset &&
              oldSamples[oldSamples.length - 1][0] <= item.reset
            ) {
              const old = forecast(
                oldSamples,
                oldSamples[oldSamples.length - 1][1],
                oldSamples[oldSamples.length - 1][0],
                item.reset,
                window,
                kind,
              );
              if (old?.ready && old.rate !== null && Number.isFinite(old.rate))
                cycles.push({
                  reset: item.reset,
                  rate: old.rate,
                  span: old.span,
                  readings: old.readings,
                });
              cycles = cycles.slice(-MAX_CYCLES);
            }
          }
          let legacySamples = item?.legacy_samples ?? [];
          if (item && !Object.hasOwn(item, "metadata"))
            legacySamples = item.samples;
          item = {
            reset,
            samples: [],
            pending: null,
            risk_alert: null,
            exhausted: false,
            metadata,
            cycles,
          };
          if (legacySamples.length) item.legacy_samples = legacySamples;
          state.windows[`${stateAccount}.${kind}`] = item;
        } else if (
          !Object.hasOwn(item, "metadata") ||
          (!sameMetadata(item.metadata, metadata) &&
            (!item.samples.length ||
              fetched > item.samples[item.samples.length - 1][0]))
        ) {
          if (!Object.hasOwn(item, "metadata") && item.samples.length)
            item.legacy_samples = item.samples;
          item.metadata = metadata;
          item.cycles = [];
          item.samples = [];
          item.pending = null;
          if (changedProfile) {
            item.risk_alert = null;
            item.exhausted = false;
          }
        }
        let samples = item.samples;
        if (!samples.length || fetched > samples[samples.length - 1][0]) {
          if (counterDropped) {
            item.samples = [];
            item.pending = null;
            item.risk_alert = null;
            item.exhausted = false;
            samples = item.samples;
          }
          samples.push([fetched, used]);
          item.samples = samples = samples
            .filter((sample) => sample[0] >= fetched - DAY)
            .slice(-MAX_SAMPLES);
          newSample = true;
        }
        const current =
          samples.length > 0 &&
          fetched === samples[samples.length - 1][0] &&
          used === samples[samples.length - 1][1];
        if (current && used >= 1 && !item.exhausted) {
          await notifier(
            `${title} ${kind} quota exhausted`,
            "Your quota is exhausted until the scheduled reset.",
          );
          item.exhausted = true;
          await commit();
        }
        if (validWindow && current && sameMetadata(item.metadata, metadata)) {
          result = forecast(
            samples,
            used,
            fetched,
            reset,
            window,
            kind,
            metadata !== null ? (item.cycles ?? []) : [],
          );
          if (kind === "weekly" && result && !result.ready && newSample)
            item.pending = null;
          if (kind === "weekly" && result?.ready) {
            const risk =
              result.overshoot >= 0.05 - 1e-12 && result.early >= 6 * HOUR;
            const recovered =
              result.overshoot <= 0.02 + 1e-12 || result.early < 3 * HOUR;
            if (newSample && recovered) item.pending = null;
            else if (risk) {
              if (!item.pending && newSample)
                item.pending = { since: fetched, count: 0 };
              if (item.pending && newSample) item.pending.count++;
              const prior = item.risk_alert;
              const allowed =
                !prior ||
                (fetched - prior.at >= DAY &&
                  (result.overshoot >= prior.overshoot + 0.1 - 1e-12 ||
                    result.early >= prior.early + 6 * HOUR));
              if (
                item.pending &&
                used < 1 &&
                item.pending.count >= 3 &&
                fetched - item.pending.since >= 1800 &&
                allowed
              ) {
                await notifier(
                  `${title} weekly quota forecast`,
                  `May run out ~${duration(result.early)} early. Reduce usage ~${Math.round(result.reduction * 100)}% to last until reset.`,
                );
                item.risk_alert = {
                  at: fetched,
                  overshoot: result.overshoot,
                  early: result.early,
                };
                await commit();
              }
            }
          }
        }
      }
      let summary: string, detail: string, color: Severity;
      if (usable && used >= 1) {
        summary = "Quota exhausted";
        detail = "No quota remaining";
        color = "red";
      } else if (
        !usable ||
        !validWindow ||
        !result ||
        reset === undefined ||
        fetched === undefined
      ) {
        summary = "Forecast unavailable";
        detail = DASH;
        color = "unavailable";
      } else {
        const unit = kind === "weekly" ? "day" : "hour";
        const progress = result.ready
          ? `Observed this cycle: ${result.readings} fresh readings across ${(result.span / HOUR).toFixed(1)} elapsed hours`
          : `Learning: ${result.readings}/3 fresh readings; ${(result.span / HOUR).toFixed(1)}/${(result.required / HOUR).toFixed(1)} elapsed hours`;
        const allowance =
          reset - now < (kind === "weekly" ? DAY : HOUR)
            ? `Remaining until reset: approximately ${(Math.max(0, 1 - used) * 100).toFixed(1)} quota points`
            : `Allowance: approximately ${(result.available * 100).toFixed(1)} quota points/${unit}`;
        detail = `${allowance} · ${progress}`;
        if (result.rate === null) {
          summary = "Learning your pace";
          color = "normal";
        } else {
          const count = item?.cycles?.length ?? 0;
          const source = !result.ready
            ? `Provisional estimate from ${count} previous cycle(s)`
            : result.prior
              ? `Based on this cycle and ${count} previous cycle(s)`
              : "Based on this cycle";
          detail += ` · Estimated pace: approximately ${(result.rate * (kind === "weekly" ? DAY : HOUR) * 100).toFixed(1)} quota points/${unit} · ${source}`;
          if (result.overshoot > 0) {
            summary = `~${duration(reset - fetched - result.early)} left · ~${duration(result.early)} before reset`;
            detail += ` · Reduce estimated pace ~${(result.reduction * 100).toFixed(0)}%`;
            color =
              result.overshoot >= 0.05 - 1e-12 &&
              (kind === "session" || result.early >= 6 * HOUR)
                ? "yellow"
                : "normal";
          } else {
            summary = "Likely lasts until reset";
            color = "normal";
          }
          if (!result.ready) summary = `Provisional · ${summary}`;
        }
      }
      row.forecast = { summary, detail, severity: color };
      output.push(row);
    }
  }
  if (staleAny)
    return {
      windows: output,
      status: "Stale data · open OpenUsage",
      severity: "unavailable",
    };
  if (!found)
    return {
      windows: output,
      status: snapshot.partial ? "Provider error" : "No usage data",
      severity: "unavailable",
    };
  const age = now - Math.min(...fetchedTimes);
  return {
    windows: output,
    status: `${snapshot.partial ? "Partial data · " : ""}Updated ${age < 60 ? "just now" : `${Math.floor(age / 60)}m ago`}`,
    severity: snapshot.partial ? "yellow" : "normal",
  };
}
