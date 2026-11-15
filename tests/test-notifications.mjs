import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

test("notification titles remain data when they resemble osascript options", async () => {
  const execute = childProcess.execFile;
  let received;
  childProcess.execFile = (file, args, options, callback) => {
    if (file !== "/usr/bin/osascript" || args[0] !== "-e")
      throw new Error("Unexpected notification transport; refusing execution");
    const safeArgs = [...args];
    // Exercise the real option parser without posting notifications.
    safeArgs[1] =
      'on run argv\nreturn item 1 of argv & "|" & item 2 of argv\nend run';
    return execute(file, safeArgs, options, (error, stdout, stderr) => {
      received = stdout;
      callback(error, stdout, stderr);
    });
  };
  syncBuiltinESMExports();
  try {
    const { sendNotification } = await import("../src/notifications.ts");
    for (const [title, body, expected] of [
      ["-x", "Quota exhausted", "-x|Quota exhausted\n"],
      [
        '-e error "not code"',
        'Quoted "body"\nsecond line',
        '-e error "not code"|Quoted "body"\nsecond line\n',
      ],
    ]) {
      received = undefined;
      await sendNotification(title, body);
      assert.equal(received, expected);
    }
  } finally {
    childProcess.execFile = execute;
    syncBuiltinESMExports();
  }
});
