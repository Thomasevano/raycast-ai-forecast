import { parseArgs } from "node:util";
import { processForecast } from "../src/forecast-engine.ts";

const USAGE =
  "Usage: openusage | npm run migrate-history -- --state-dir DIRECTORY --assign-legacy 'codex=codex@ACCOUNT_ID'";

async function main(): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        "state-dir": { type: "string" },
        "assign-legacy": { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new Error(USAGE);
  }
  const directory = values["state-dir"];
  const assignments = values["assign-legacy"];
  if (!directory?.trim() || !assignments?.length) throw new Error(USAGE);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) throw new Error("OpenUsage snapshot exceeds 1 MiB");
    chunks.push(bytes);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid OpenUsage JSON; history has not been changed");
  }
  await processForecast(payload, {
    stateDirectory: directory,
    assignLegacy: assignments,
  });
  process.stdout.write(
    "Legacy history assigned. No samples or notifications were added.\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `History migration: ${error instanceof Error ? error.message : "Migration failed"}\n`,
  );
  process.exitCode = 1;
});
