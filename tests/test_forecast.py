"""Deterministic quota, forecast and durable alert behavior."""
import importlib.util
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest

MODEL = Path(__file__).resolve().parents[1] / "assets/openusage-model.py"
spec = importlib.util.spec_from_file_location("openusage_model", MODEL)
model = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)
NOW = 2_000_000_000
HOUR = 3600
DAY = 86400


def iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")


def quota(used, reset=NOW + 4 * DAY, window=7 * DAY):
    return {"kind": "consumption", "utilization": used,
            "resetsAt": iso(reset), "windowSeconds": window}


def provider(resources, now=NOW, **extra):
    return {"plan": "Pro 100", "fetchedAt": iso(now), "expiresAt": iso(now + 600),
            "stale": False, "resources": resources, **extra}


def payload(providers, errors=None):
    return {"schema": "openusage.limits.v1", "providers": providers, "errors": errors or []}


def payload_v2(providers):
    return {"schema": "openusage.limits.v2", "providers": providers}


class UsageModelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.sent = []

    def run_model(self, providers, now=NOW, errors=None, notifier=None):
        rows = model.process(payload(providers, errors), self.temp.name, now,
                             notifier if notifier is not None else lambda title, body: self.sent.append((title, body)))
        return {(row[0], row[1] if row[0] in ("provider", "resource", "forecast") else ""): row for row in rows}

    def sample(self, offset, used, reset=NOW + 4 * DAY):
        now = NOW + offset
        return self.run_model({"codex": provider({"weekly": quota(used, reset)}, now)}, now)

    def risk_history(self):
        for offset, used in ((0, .57), (3 * HOUR, .585), (6 * HOUR, .60),
                             (6 * HOUR + 900, .61), (6 * HOUR + 1800, .62)):
            rows = self.sample(offset, used)
        return rows

    def test_visibility_validation_and_zero(self):
        rows = self.run_model({"codex": provider({"weekly": quota(0), "session": {"kind": "balance", "utilization": 1}})})
        self.assertEqual(rows["provider", "claude"][-1], "off")
        self.assertEqual(rows["resource", "codex.session"][-1], "off")
        state = json.loads((Path(self.temp.name) / "state.json").read_text())
        self.assertEqual(state["windows"]["codex.weekly"]["samples"], [[NOW, 0]])
        self.assertEqual(rows["forecast", "codex.weekly"][-2], "normal")
        for invalid in (-1, "0.5", float("nan"), float("inf"), True):
            rows = self.run_model({"codex": provider({"weekly": quota(invalid)})})
            self.assertEqual(rows["resource", "codex.weekly"][-1], "off")

    def test_sanitizes_provider_text_and_partial_status(self):
        rows = self.run_model({"codex": provider({}, plan="Pro\t100\nInjected\x00")}, errors=[{}])
        self.assertEqual(rows["provider", "codex"][3], "Pro 100 Injected")
        self.assertEqual(rows["status", ""][-1], "unavailable")
        rows = self.run_model({"codex": provider({"session": quota(.2)})}, errors=[{}])
        self.assertEqual(rows["status", ""][-1], "yellow")

    def test_stale_expired_future_and_missing_fetch_never_alert(self):
        for extra in ({"stale": True}, {"expiresAt": iso(NOW - 1)},
                      {"fetchedAt": iso(NOW + 1)}, {"fetchedAt": None},
                      {"fetchedAt": iso(NOW - 901), "expiresAt": None}):
            rows = self.run_model({"codex": provider({"weekly": quota(1)}, **extra)})
            self.assertEqual(rows["resource", "codex.weekly"][-2], "unavailable")
            self.assertEqual(rows["forecast", "codex.weekly"][-2], "unavailable")
        self.assertEqual(self.sent, [])
        rows = self.run_model({"codex": provider({"weekly": quota(1, NOW - 1)})})
        self.assertEqual(rows["resource", "codex.weekly"][-2], "unavailable")
        self.assertEqual(self.sent, [])

    def test_missing_reset_and_window_do_not_fabricate_forecast(self):
        rows = self.run_model({"codex": provider({"weekly": {"kind": "consumption", "utilization": .2}})})
        self.assertEqual(rows["resource", "codex.weekly"][-2], "unavailable")
        self.assertEqual(rows["forecast", "codex.weekly"][-2], "unavailable")

    def test_sustained_risk_requires_distinct_readings_and_survives_restart(self):
        for offset, used in ((0, .57), (3 * HOUR, .585), (6 * HOUR, .60)):
            rows = self.sample(offset, used)
        self.assertEqual(rows["forecast", "codex.weekly"][5], "yellow")
        for _ in range(5):
            self.sample(6 * HOUR, .60)
        self.assertEqual(self.sent, [])
        self.sample(6 * HOUR + 900, .61)
        self.assertEqual(self.sent, [])
        self.sample(6 * HOUR + 1800, .62)
        self.assertEqual(len(self.sent), 1)
        self.sample(6 * HOUR + 1800, .62)
        self.sample(7 * HOUR, .65)
        self.assertEqual(len(self.sent), 1)

    def test_exhaustion_separate_per_window_and_drop_resets(self):
        self.risk_history()
        self.sample(7 * HOUR, 1)
        self.sample(7 * HOUR, 1)
        self.assertEqual(len(self.sent), 2)
        self.sample(8 * HOUR, .5)
        self.sample(9 * HOUR, 1)
        self.assertEqual(len(self.sent), 3)
        self.sample(10 * HOUR, 1, reset=NOW + 5 * DAY)
        self.assertEqual(len(self.sent), 4)

    def test_cooldown_requires_material_worsening(self):
        self.risk_history()
        self.sample(7 * HOUR, .90)
        self.assertEqual(len(self.sent), 1)
        self.sample(30 * HOUR + 1800, .99)
        self.assertEqual(len(self.sent), 2)
        self.sample(30 * HOUR + 1800, .99)
        self.assertEqual(len(self.sent), 2)

    def test_idle_recovery_cancels_pending_risk(self):
        for offset, used in ((0, .57), (3 * HOUR, .585), (6 * HOUR, .60)):
            self.sample(offset, used)
        self.sample(54 * HOUR, .60)
        state = json.loads((Path(self.temp.name) / "state.json").read_text())
        self.assertIsNone(state["windows"]["codex.weekly"]["pending"])
        self.assertEqual(self.sent, [])

    def test_session_exhaustion_and_failed_dispatch_retry(self):
        data = {"codex": provider({"session": quota(1)})}
        def fail(title, body):
            raise OSError("notification failed")
        with self.assertRaises(OSError):
            self.run_model(data, notifier=fail)
        self.run_model(data)
        self.run_model(data)
        self.assertEqual(len(self.sent), 1)
        state = json.loads((Path(self.temp.name) / "state.json").read_text())
        self.assertTrue(state["windows"]["codex.session"]["exhausted"])

    def test_risk_dispatch_failure_retries_same_snapshot(self):
        for offset, used in ((0, .57), (3 * HOUR, .585), (6 * HOUR, .60), (6 * HOUR + 900, .61)):
            self.sample(offset, used)
        now = NOW + 6 * HOUR + 1800
        data = {"codex": provider({"weekly": quota(.62)}, now)}
        def fail(title, body):
            raise OSError("notification failed")
        with self.assertRaises(OSError):
            self.run_model(data, now, notifier=fail)
        self.run_model(data, now)
        self.assertEqual(len(self.sent), 1)

    def test_preview_cli_exhaustion_without_state_directory(self):
        directory = Path(self.temp.name) / "not-created"
        data = payload({"codex": provider({"weekly": quota(1)})})
        subprocess.run(
            [sys.executable, str(MODEL), "--state-dir", str(directory), "--now", str(NOW), "--preview"],
            input=json.dumps(data), text=True, capture_output=True, check=True,
        )
        self.assertFalse(directory.exists())
        model.process(data, directory, NOW, lambda title, body: self.sent.append((title, body)))
        self.assertEqual(len(self.sent), 1)

    def test_preview_does_not_consume_pending_risk_or_samples(self):
        for offset, used in ((0, .57), (3 * HOUR, .585), (6 * HOUR, .60), (6 * HOUR + 900, .61)):
            self.sample(offset, used)
        path = Path(self.temp.name) / "state.json"
        before = path.read_bytes()
        now = NOW + 6 * HOUR + 1800
        data = payload({"codex": provider({"weekly": quota(.62)}, now)})
        rows = model.process(data, self.temp.name, now,
                             lambda title, body: self.sent.append((title, body)), preview=True)
        self.assertEqual(next(row for row in rows if row[:2] == ["forecast", "codex.weekly"])[5], "yellow")
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.sent, [])
        model.process(data, self.temp.name, now, lambda title, body: self.sent.append((title, body)))
        self.assertEqual(len(self.sent), 1)
        state = json.loads(path.read_text())
        self.assertIsNotNone(state["windows"]["codex.weekly"]["risk_alert"])

    def test_preview_does_not_consume_exhaustion_or_change_existing_history(self):
        self.sample(0, .2)
        path = Path(self.temp.name) / "state.json"
        before = path.read_bytes()
        now = NOW + 300
        data = payload({"codex": provider({"weekly": quota(1)}, now)})
        model.process(data, self.temp.name, now,
                             lambda title, body: self.sent.append((title, body)), preview=True)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.sent, [])
        model.process(data, self.temp.name, now, lambda title, body: self.sent.append((title, body)))
        self.assertEqual(len(self.sent), 1)
        self.assertTrue(json.loads(path.read_text())["windows"]["codex.weekly"]["exhausted"])

    def test_preview_rejects_corrupt_state(self):
        path = Path(self.temp.name) / "state.json"
        path.write_text("{broken")
        with self.assertRaises(ValueError):
            model.process(payload({"codex": provider({"weekly": quota(1)})}),
                          self.temp.name, NOW, preview=True)
        self.assertEqual(path.read_text(), "{broken")

    def test_corrupt_state_fails_closed_and_private_permissions(self):
        self.sample(0, .2)
        directory = Path(self.temp.name)
        self.assertEqual(os.stat(directory).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(directory / "state.json").st_mode & 0o777, 0o600)
        (directory / "state.json").write_text("{broken")
        with self.assertRaises(ValueError):
            self.sample(100, .3)
        self.assertEqual((directory / "state.json").read_text(), "{broken")

    def test_zero_burn_forecast_and_malformed_payload(self):
        for offset in (0, 3 * HOUR, 6 * HOUR):
            rows = self.sample(offset, 0)
        self.assertEqual(rows["forecast", "codex.weekly"][-2], "normal")
        result = model.forecast([[NOW, 0], [NOW + 3 * HOUR, 0], [NOW + 6 * HOUR, 0]],
                                0, NOW + 6 * HOUR, NOW + 4 * DAY, 7 * DAY)
        self.assertEqual(result["early"], 0)
        self.assertEqual(result["overshoot"], -1)
        self.assertEqual(self.sent, [])
        with self.assertRaises(ValueError):
            model.process({"providers": {}}, self.temp.name, NOW, lambda *_: None)

    def test_explicit_expiry_and_fallback_age(self):
        rows = self.run_model({"codex": provider({"weekly": quota(.2)},
                                                fetchedAt=iso(NOW - HOUR))})
        self.assertEqual(rows["resource", "codex.weekly"][-2], "normal")
        rows = self.run_model({"codex": provider({"weekly": quota(1)},
                                                fetchedAt=iso(NOW - 901), expiresAt=None)})
        self.assertEqual(rows["resource", "codex.weekly"][-2], "unavailable")
        self.assertEqual(self.sent, [])

    def test_out_of_order_window_cannot_clear_notification_dedup(self):
        self.sample(0, 1)
        self.sample(300, 1, reset=NOW + 5 * DAY)
        self.assertEqual(len(self.sent), 2)
        old = {"codex": provider({"weekly": quota(1)}, now=NOW)}
        rows = self.run_model(old, now=NOW + 300)
        self.assertEqual(rows["resource", "codex.weekly"][-2], "unavailable")
        self.sample(300, 1, reset=NOW + 5 * DAY)
        self.assertEqual(len(self.sent), 2)
        state = json.loads((Path(self.temp.name) / "state.json").read_text())
        self.assertEqual(state["windows"]["codex.weekly"]["reset"], NOW + 5 * DAY)

    def test_blended_rate_budget_and_idle_time(self):
        samples = [[NOW, .2], [NOW + 3 * HOUR, .25], [NOW + 6 * HOUR, .3]]
        result = model.forecast(samples, .3, NOW + 6 * HOUR, NOW + 4 * DAY, 7 * DAY)
        self.assertAlmostEqual(result["available"], .1866666666666667)
        self.assertAlmostEqual(result["overshoot"], .223076923076923)
        self.assertAlmostEqual(result["early"], 21.75 * HOUR)
        self.assertAlmostEqual(result["reduction"], .2416666666666667)

    def test_v2_accounts_are_isolated_and_identifiers_are_safe(self):
        accounts = {
            "codex@one": provider({"weekly": quota(1)}, displayName="Work\taccount\n"),
            "codex@two": provider({"weekly": quota(.2)}, displayName=""),
            "cursor@other": provider({"weekly": quota(1)}),
        }
        rows = model.process(payload_v2(accounts), self.temp.name, NOW,
                             lambda *args: self.sent.append(args))
        self.assertEqual(next(r for r in rows if r[:2] == ["provider", "codex@one"])[2], "Work account")
        self.assertEqual(len(self.sent), 1)
        state = json.loads((Path(self.temp.name) / "state.json").read_text())
        self.assertEqual(state["windows"]["codex@one.weekly"]["samples"], [[NOW, 1]])
        self.assertEqual(state["windows"]["codex@two.weekly"]["samples"], [[NOW, .2]])
        self.assertNotIn("cursor@other.weekly", state["windows"])
        with self.assertRaises(ValueError):
            model.process(payload_v2({"codex@evil\tkey": provider({})}), self.temp.name, NOW)

    def test_singleton_migration_and_format_round_trip_preserves_dedup(self):
        self.sample(0, 1)
        self.assertEqual(len(self.sent), 1)
        path = Path(self.temp.name) / "state.json"
        state = json.loads(path.read_text())
        record = state["windows"]["codex.weekly"]
        record["pending"] = {"since": NOW - 100, "count": 2}
        record["risk_alert"] = {"at": NOW - 100, "overshoot": .2, "early": 30000}
        state = {"version": 1, "windows": state["windows"]}
        path.write_text(json.dumps(state))
        account = "codex@one"
        data = payload_v2({account: provider({"weekly": quota(1)})})
        model.process(data, self.temp.name, NOW, lambda *args: self.sent.append(args))
        migrated = json.loads(path.read_text())
        self.assertEqual(migrated["version"], 3)
        self.assertEqual(migrated["legacy_bindings"], {"codex": account})
        self.assertEqual(migrated["windows"][account + ".weekly"], record)
        self.assertNotIn("codex.weekly", migrated["windows"])
        self.run_model({"codex": provider({"weekly": quota(1)})})
        model.process(data, self.temp.name, NOW, lambda *args: self.sent.append(args))
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(json.loads(path.read_text())["windows"][account + ".weekly"], record)

    def test_fresh_v2_format_round_trip_does_not_repeat_exhaustion(self):
        data = payload_v2({"codex@one": provider({"weekly": quota(1)})})
        model.process(data, self.temp.name, NOW, lambda *args: self.sent.append(args))
        path = Path(self.temp.name) / "state.json"
        before = json.loads(path.read_text())
        self.run_model({"codex": provider({"weekly": quota(1)})})
        model.process(data, self.temp.name, NOW, lambda *args: self.sent.append(args))
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(json.loads(path.read_text()), before)

    def test_invalid_v2_account_cannot_bind_legacy_history(self):
        self.sample(0, .2)
        path = Path(self.temp.name) / "state.json"
        before = path.read_bytes()
        with self.assertRaises(ValueError):
            model.process(payload_v2({"codex@one": None}), self.temp.name, NOW,
                          lambda *args: self.sent.append(args))
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.sent, [])

    def test_ambiguous_history_fails_without_writes_or_notifications(self):
        self.sample(0, .2)
        path = Path(self.temp.name) / "state.json"
        before = path.read_bytes()
        data = payload_v2({name: provider({"weekly": quota(1)})
                           for name in ("codex@one", "codex@two")})
        with self.assertRaisesRegex(ValueError, "^Ambiguous legacy history"):
            model.process(data, self.temp.name, NOW, lambda *args: self.sent.append(args))
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.sent, [])
        with self.assertRaisesRegex(ValueError, "^Ambiguous legacy history"):
            model.process(data, self.temp.name, NOW, preview=True)
        self.assertEqual(path.read_bytes(), before)

    def test_explicit_migration_is_atomic_and_does_not_sample_or_notify(self):
        self.sample(0, .2)
        path = Path(self.temp.name) / "state.json"
        before = path.read_bytes()
        legacy = json.loads(before)["windows"]["codex.weekly"]
        data = payload_v2({
            "codex@one": provider({"weekly": quota(1)}),
            "codex@two": provider({"weekly": quota(1)}),
            "claude@one": provider({"weekly": quota(1)}),
        })
        for choices in (["codex=codex@missing"], ["codex=claude@one"],
                        ["codex=codex@one", "codex=codex@two"],
                        ["codex=codex@one", "claude=claude@missing"]):
            with self.assertRaises(ValueError):
                model.process(data, self.temp.name, NOW, lambda *args: self.sent.append(args),
                              assign_legacy=choices)
            self.assertEqual(path.read_bytes(), before)
        subprocess.run(
            [sys.executable, str(MODEL), "--state-dir", self.temp.name,
             "--assign-legacy", "codex=codex@two"],
            input=json.dumps(data), text=True, capture_output=True, check=True)
        state = json.loads(path.read_text())
        self.assertEqual(state["windows"], {"codex@two.weekly": legacy})
        self.assertEqual(state["legacy_bindings"], {"codex": "codex@two"})
        self.assertEqual(self.sent, [])
        with self.assertRaises(ValueError):
            model.process(data, self.temp.name, NOW, assign_legacy=["codex=codex@one"])

    def test_migration_collision_and_preview_do_not_change_state(self):
        self.sample(0, .2)
        path = Path(self.temp.name) / "state.json"
        state = json.loads(path.read_text())
        state["windows"]["codex@one.weekly"] = dict(state["windows"]["codex.weekly"])
        path.write_text(json.dumps(state))
        before = path.read_bytes()
        data = payload_v2({"codex@one": provider({"weekly": quota(1)})})
        for choices in (None, ["codex=codex@one"]):
            with self.assertRaisesRegex(ValueError, "collision"):
                model.process(data, self.temp.name, NOW, lambda *args: self.sent.append(args),
                              assign_legacy=choices)
            self.assertEqual(path.read_bytes(), before)
        state["windows"].pop("codex@one.weekly")
        path.write_text(json.dumps(state))
        before = path.read_bytes()
        rows = model.process(data, self.temp.name, NOW, lambda *args: self.sent.append(args), preview=True)
        self.assertTrue(any(row[:2] == ["resource", "codex@one.weekly"] for row in rows))
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.sent, [])

    def test_bound_account_disappearance_never_rebinds_legacy_history(self):
        self.sample(0, 1)
        data = payload_v2({"codex@one": provider({"weekly": quota(1)})})
        model.process(data, self.temp.name, NOW, lambda *args: self.sent.append(args))
        other = payload_v2({"codex@two": provider({"weekly": quota(.2)})})
        model.process(other, self.temp.name, NOW, lambda *args: self.sent.append(args))
        state = json.loads((Path(self.temp.name) / "state.json").read_text())
        self.assertEqual(state["legacy_bindings"], {"codex": "codex@one"})
        self.assertTrue(state["windows"]["codex@one.weekly"]["exhausted"])
        self.assertEqual(state["windows"]["codex@two.weekly"]["samples"], [[NOW, .2]])
        self.run_model({"codex": provider({"weekly": quota(1)})})
        self.assertEqual(len(self.sent), 1)

    def test_session_rate_confidence_and_allowance(self):
        reset = NOW + 5 * HOUR
        for offset, used in ((0, .1), (1800, .15), (3600, .2)):
            rows = self.run_model({"codex": provider({"session": quota(used, reset, 5 * HOUR)}, NOW + offset)},
                                  NOW + offset)
        state = json.loads((Path(self.temp.name) / "state.json").read_text())
        samples = state["windows"]["codex.session"]["samples"]
        result = model.forecast(samples, .2, NOW + HOUR, reset, 5 * HOUR, "session")
        self.assertTrue(result["ready"])
        self.assertAlmostEqual(result["available"], .2)
        self.assertAlmostEqual(result["rate"] * HOUR, .15)
        self.assertEqual(rows["forecast", "codex.session"][6], "on")
        self.assertEqual(self.sent, [])
        self.assertEqual(model.confidence_span("session", 2 * HOUR), 1800)

    def test_session_cycles_archive_observations_and_bound_history(self):
        window = 5 * HOUR
        for cycle in range(6):
            start = NOW + cycle * window
            reset = start + window
            for offset, used in ((0, .05), (1800, .1), (3600, .15)):
                now = start + offset
                self.run_model({"codex": provider({"session": quota(used, reset, window)}, now)}, now)
        state = json.loads((Path(self.temp.name) / "state.json").read_text())
        item = state["windows"]["codex.session"]
        self.assertEqual(len(item["cycles"]), 4)
        self.assertEqual([cycle["reset"] for cycle in item["cycles"]],
                         [NOW + window * n for n in (2, 3, 4, 5)])
        self.assertTrue(all(cycle["readings"] == 3 and cycle["span"] == HOUR for cycle in item["cycles"]))
        self.assertTrue(all(cycle["rate"] > 0 for cycle in item["cycles"]))
        self.assertEqual(self.sent, [])

    def test_prior_is_provisional_then_current_dominates(self):
        reset, window = NOW + 4 * DAY, 7 * DAY
        for offset, used in ((0, .87), (3 * HOUR, .885), (6 * HOUR, .90)):
            self.sample(offset, used, reset)
        self.sent.clear()
        for offset, used in ((HOUR, .10), (2 * HOUR, .11), (3 * HOUR, .12)):
            now = reset + offset
            self.run_model({"codex": provider({"weekly": quota(used, reset + window, window)}, now)}, now)
        item = json.loads((Path(self.temp.name) / "state.json").read_text())["windows"]["codex.weekly"]
        self.assertEqual(len(item["cycles"]), 1)
        provisional = model.forecast(item["samples"], .12, reset + 3 * HOUR, reset + window,
                                     window, "weekly", item["cycles"])
        self.assertFalse(provisional["ready"])
        self.assertAlmostEqual(provisional["rate"], item["cycles"][0]["rate"])
        self.assertIsNone(item["pending"])
        self.assertEqual(self.sent, [])
        self.assertGreater(provisional["overshoot"], .05)
        for offset, used in ((4 * HOUR, .13), (7 * HOUR, .16)):
            now = reset + offset
            self.run_model({"codex": provider({"weekly": quota(used, reset + window, window)}, now)}, now)
        item = json.loads((Path(self.temp.name) / "state.json").read_text())["windows"]["codex.weekly"]
        current = model.forecast(item["samples"], .16, reset + 7 * HOUR, reset + window, window)
        blended = model.forecast(item["samples"], .16, reset + 7 * HOUR, reset + window,
                                 window, "weekly", item["cycles"])
        self.assertTrue(blended["ready"])
        self.assertAlmostEqual(blended["rate"], .75 * current["rate"] + .25 * item["cycles"][0]["rate"])

    def test_incompatible_metadata_and_non_boundary_do_not_archive(self):
        window = 5 * HOUR
        for offset, used in ((0, .1), (1800, .2), (3600, .3)):
            now = NOW + offset
            self.run_model({"codex": provider({"session": quota(used, NOW + window, window)}, now)}, now)
        # An altered reset before the previous boundary is not a completed cycle.
        now = NOW + 2 * HOUR
        self.run_model({"codex": provider({"session": quota(.1, NOW + 2 * window, window)}, now)}, now)
        path = Path(self.temp.name) / "state.json"
        self.assertEqual(json.loads(path.read_text())["windows"]["codex.session"]["cycles"], [])
        # Missing plan and a subsequent changed plan must not establish compatible provenance.
        for offset, used in ((0, .1), (1800, .2), (3600, .3)):
            now = NOW + 3 * HOUR + offset
            self.run_model({"codex": provider({"session": quota(used, NOW + 2 * window, window)},
                                               now, plan=None)}, now)
        now = NOW + 2 * window + 1
        self.run_model({"codex": provider({"session": quota(.1, NOW + 3 * window, window)},
                                           now, plan="Other")}, now)
        self.assertEqual(json.loads(path.read_text())["windows"]["codex.session"]["cycles"], [])

    def test_preview_reset_and_old_snapshots_never_archive(self):
        window, reset = 5 * HOUR, NOW + 5 * HOUR
        for offset, used in ((0, .1), (1800, .2), (3600, .3)):
            now = NOW + offset
            self.run_model({"codex": provider({"session": quota(used, reset, window)}, now)}, now)
        path = Path(self.temp.name) / "state.json"
        before = path.read_bytes()
        now = reset + 1
        data = payload({"codex": provider({"session": quota(.1, reset + window, window)}, now)})
        model.process(data, self.temp.name, now, preview=True)
        self.assertEqual(path.read_bytes(), before)
        self.run_model({"codex": provider({"session": quota(.3, reset, window)}, NOW + HOUR,
                                           stale=True)}, now)
        self.assertEqual(json.loads(path.read_text())["windows"]["codex.session"]["cycles"], [])
        model.process(data, self.temp.name, now, lambda *args: self.sent.append(args))
        self.assertEqual(len(json.loads(path.read_text())["windows"]["codex.session"]["cycles"]), 1)
        model.process(data, self.temp.name, now, lambda *args: self.sent.append(args))
        self.assertEqual(len(json.loads(path.read_text())["windows"]["codex.session"]["cycles"]), 1)

    def test_preview_with_existing_directory_does_not_create_lock(self):
        directory = Path(self.temp.name) / "empty"
        directory.mkdir()
        model.process(payload({"codex": provider({"weekly": quota(.2)})}), directory, NOW, preview=True)
        self.assertEqual(list(directory.iterdir()), [])
    def test_legacy_samples_preserved_without_inventing_provenance(self):
        path = Path(self.temp.name) / "state.json"
        samples = [[NOW, .1], [NOW + HOUR, .2]]
        record = {"reset": NOW + 4 * DAY, "samples": samples, "pending": None,
                  "risk_alert": None, "exhausted": False}
        path.write_text(json.dumps({"version": 2, "windows": {"codex.weekly": record},
                                    "legacy_bindings": {}}))
        now = NOW + 2 * HOUR
        self.run_model({"codex": provider({"weekly": quota(.3)}, now)}, now)
        state = json.loads(path.read_text())
        item = state["windows"]["codex.weekly"]
        self.assertEqual(state["version"], 3)
        self.assertEqual(item["legacy_samples"], samples)
        self.assertEqual(item["samples"], [[now, .3]])
        self.assertEqual(item["cycles"], [])

    def test_account_and_window_history_are_isolated(self):
        window, reset = 5 * HOUR, NOW + 5 * HOUR
        for offset, used in ((0, .1), (1800, .2), (3600, .3)):
            now = NOW + offset
            model.process(payload_v2({"codex@one": provider({"session": quota(used, reset, window)}, now),
                                      "codex@two": provider({"session": quota(used, reset, window)}, now)}),
                          self.temp.name, now, lambda *args: self.sent.append(args))
        now = reset + 1
        data = payload_v2({
            "codex@one": provider({"session": quota(.1, reset + window, window),
                                    "weekly": quota(.1, now + 7 * DAY)}, now),
            "codex@two": provider({"session": quota(.1, reset + 2 * window, 2 * window)}, now),
        })
        model.process(data, self.temp.name, now, lambda *args: self.sent.append(args))
        state = json.loads((Path(self.temp.name) / "state.json").read_text())["windows"]
        self.assertEqual(len(state["codex@one.session"]["cycles"]), 1)
        self.assertEqual(state["codex@one.weekly"]["cycles"], [])
        self.assertEqual(state["codex@two.session"]["cycles"], [])



    def test_known_plan_change_does_not_suppress_new_exhaustion(self):
        reset = NOW + 5 * HOUR
        for offset, plan in ((0, "First"), (300, "First"), (600, "Second"), (900, "Second")):
            now = NOW + offset
            self.run_model({"codex": provider({"session": quota(1, reset, 5 * HOUR)}, now, plan=plan)}, now)
        self.assertEqual(len(self.sent), 2)

    def test_new_known_window_can_reset_earlier_and_alert(self):
        self.run_model({"codex": provider({"session": quota(.5, NOW + 5 * HOUR, 5 * HOUR)})})
        now = NOW + 300
        rows = self.run_model({"codex": provider({"session": quota(1, NOW + 3 * HOUR, 3 * HOUR)}, now)}, now)
        self.assertEqual(rows["resource", "codex.session"][5], "red")
        self.assertEqual(len(self.sent), 1)
        item = json.loads((Path(self.temp.name) / "state.json").read_text())["windows"]["codex.session"]
        self.assertEqual(item["reset"], NOW + 3 * HOUR)
        self.assertEqual(item["cycles"], [])

    def test_legacy_without_plan_cannot_use_old_samples_for_risk(self):
        path = Path(self.temp.name) / "state.json"
        samples = [[NOW, .6], [NOW + 3 * HOUR, .65], [NOW + 6 * HOUR, .7]]
        for plan in (None, "", " "):
            for offset in (6 * HOUR, 6 * HOUR + 1800):
                with self.subTest(plan=plan, offset=offset):
                    record = {"reset": NOW + 4 * DAY, "samples": samples,
                              "pending": {"since": NOW + 5 * HOUR, "count": 3},
                              "risk_alert": None, "exhausted": False}
                    path.write_text(json.dumps({"version": 2, "windows": {"codex.weekly": record}}))
                    now = NOW + offset
                    used = .7 if offset == 6 * HOUR else .8
                    self.run_model({"codex": provider({"weekly": quota(used)}, now, plan=plan)}, now)
                    item = json.loads(path.read_text())["windows"]["codex.weekly"]
                    self.assertEqual(item["legacy_samples"], samples)
                    self.assertEqual(item["samples"], [[now, used]])
                    self.assertIsNone(item["pending"])
                    self.assertEqual(self.sent, [])

    def test_legacy_drop_then_exhaustion_can_alert_again(self):
        path = Path(self.temp.name) / "state.json"
        record = {"reset": NOW + 4 * DAY, "samples": [[NOW, 1]], "pending": None,
                  "risk_alert": None, "exhausted": True}
        path.write_text(json.dumps({"version": 2, "windows": {"codex.weekly": record}}))
        for offset, used in ((300, .5), (600, 1), (900, 1)):
            self.sample(offset, used)
        self.assertEqual(len(self.sent), 1)
        self.assertTrue(json.loads(path.read_text())["windows"]["codex.weekly"]["exhausted"])

    def test_legacy_changed_counter_at_same_fetch_cannot_alert(self):
        path = Path(self.temp.name) / "state.json"
        record = {"reset": NOW + 4 * DAY, "samples": [[NOW, .5]], "pending": None,
                  "risk_alert": None, "exhausted": False}
        path.write_text(json.dumps({"version": 2, "windows": {"codex.weekly": record}}))
        self.sample(0, 1)
        self.assertEqual(self.sent, [])
        self.assertEqual(json.loads(path.read_text())["windows"]["codex.weekly"]["samples"], [[NOW, .5]])
        self.sample(300, 1)
        self.assertEqual(len(self.sent), 1)

if __name__ == "__main__":
    unittest.main()
