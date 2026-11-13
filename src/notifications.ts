import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const SCRIPT =
  "on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run";

export async function sendNotification(
  title: string,
  body: string,
): Promise<void> {
  await execute("/usr/bin/osascript", ["-e", SCRIPT, title, body], {
    timeout: 10000,
  });
}
