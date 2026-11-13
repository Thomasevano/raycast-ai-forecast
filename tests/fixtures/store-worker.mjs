import {
  readState,
  saveState,
  withStateLock,
} from "../../src/forecast-store.ts";

const [directory, mode] = process.argv.slice(2);
try {
  await withStateLock(directory, async () => {
    process.send?.("acquired");
    if (mode === "hold") {
      await new Promise((resolve) => process.once("message", resolve));
    } else {
      const state = (await readState(directory)) ?? { count: 0 };
      await new Promise((resolve) => setTimeout(resolve, 30));
      await saveState(directory, { count: state.count + 1 });
    }
  });
  process.send?.("done");
  process.disconnect?.();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
}
