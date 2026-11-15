import assert from "node:assert/strict";
import test from "node:test";
import {
  monitoringEnabled,
  updateMonitorHealth,
} from "../src/monitoring-state.ts";

test("monitoring state accepts persisted booleans and their native numeric values", () => {
  for (const value of [true, 1]) assert.equal(monitoringEnabled(value), true);
  for (const value of [false, 0, undefined])
    assert.equal(monitoringEnabled(value), false);
  for (const value of ["false", 2, -1])
    assert.throws(() => monitoringEnabled(value));
});

test("health only changes when stored values or overdue status change", () => {
  const unknown = { checkedAt: 1000 };
  const reading = { enabled: true, last: 1000, error: undefined };
  const initial = updateMonitorHealth(unknown, reading, 2000);
  assert.notStrictEqual(initial, unknown);
  assert.strictEqual(updateMonitorHealth(initial, reading, 601000), initial);
  const overdue = updateMonitorHealth(initial, reading, 601001);
  assert.notStrictEqual(overdue, initial);
  assert.equal(overdue.checkedAt, 601001);
  assert.strictEqual(updateMonitorHealth(overdue, reading, 610000), overdue);
  const recovered = updateMonitorHealth(
    overdue,
    { ...reading, last: 610000 },
    610000,
  );
  assert.equal(recovered.last, 610000);
  assert.notStrictEqual(recovered, overdue);
  const failed = updateMonitorHealth(
    recovered,
    { error: "Read failed" },
    611000,
  );
  assert.equal(failed.enabled, undefined);
  assert.equal(failed.error, "Read failed");
  assert.strictEqual(
    updateMonitorHealth(failed, { error: "Read failed" }, 612000),
    failed,
  );
  assert.notStrictEqual(updateMonitorHealth(failed, reading, 613000), failed);
});
