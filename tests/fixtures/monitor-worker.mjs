import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { processForecast } from "../../src/forecast-engine.ts";

const [stateDirectory, input, now] = process.argv.slice(2);
await processForecast(JSON.parse(input), {
  stateDirectory,
  now: Number(now),
  notifier: () =>
    appendFile(join(stateDirectory, "delivered.log"), "delivered\n"),
});
