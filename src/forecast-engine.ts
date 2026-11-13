import {
  migrateState,
  parseSnapshot,
  renderForecast,
  validateState,
} from "./forecast-model.ts";
import { readState, saveState, withStateLock } from "./forecast-store.ts";
import type { ForecastState, Notifier, Snapshot } from "./forecast-types.ts";
import { sendNotification } from "./notifications.ts";

interface ForecastOptions {
  stateDirectory: string;
  now?: number;
  preview?: boolean;
  assignLegacy?: readonly string[];
  notifier?: Notifier;
  signal?: AbortSignal;
}

async function loadState(directory: string): Promise<ForecastState> {
  const stored = await readState(directory);
  const state = stored === undefined ? { version: 1, windows: {} } : stored;
  validateState(state);
  return state;
}

const nothing = async (): Promise<void> => {};

export async function processForecast(
  payload: unknown,
  options: ForecastOptions,
): Promise<Snapshot> {
  options.signal?.throwIfAborted();
  const now = options.now ?? Date.now() / 1000;
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new Error("Invalid current time");
  }
  const source = parseSnapshot(payload);
  if (
    options.assignLegacy !== undefined &&
    (options.preview || source.schema !== "openusage.limits.v2")
  ) {
    throw new Error(
      "Legacy assignment requires a v2 payload and cannot be previewed",
    );
  }
  if (options.preview) {
    const state = await loadState(options.stateDirectory);
    options.signal?.throwIfAborted();
    migrateState(state, source.providers);
    return renderForecast(source, state, now, nothing, nothing);
  }
  return withStateLock(
    options.stateDirectory,
    async () => {
      const state = await loadState(options.stateDirectory);
      options.signal?.throwIfAborted();
      migrateState(state, source.providers, options.assignLegacy);
      const commit = () => saveState(options.stateDirectory, state);
      if (options.assignLegacy !== undefined) {
        await commit();
        return {
          windows: [],
          status: "Legacy history assigned",
          severity: "normal",
        };
      }
      let result: Snapshot;
      try {
        result = await renderForecast(
          source,
          state,
          now,
          options.notifier ?? sendNotification,
          commit,
        );
      } catch (error) {
        // Preserve observations and earlier successful deliveries, never failed flags.
        await commit();
        throw error;
      }
      await commit();
      return result;
    },
    options.signal,
  );
}
