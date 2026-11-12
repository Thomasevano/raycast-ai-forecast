#!/usr/bin/env python3
"""Render OpenUsage quotas and issue durable, quiet forecast notifications."""
import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime

DAY = 86400
HOUR = 3600
MAX_SAMPLES = 2048
MAX_CYCLES = 4
DASH = "—"


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.timestamp() if parsed.tzinfo else None
    except (ValueError, OverflowError, OSError):
        return None


def clean(value):
    if not isinstance(value, str):
        return DASH
    return " ".join("".join(" " if ord(c) < 32 or 127 <= ord(c) <= 159 else c for c in value).split())[:64] or DASH


def duration(seconds):
    if seconds < HOUR:
        return f"{max(1, math.ceil(seconds / 60))}m"
    if seconds < DAY:
        return f"{math.ceil(seconds / HOUR)}h"
    days, hours = divmod(math.ceil(seconds / HOUR), 24)
    return f"{days}d {hours}h" if hours else f"{days}d"


def notify(title, body):
    subprocess.run(["/usr/bin/osascript", "-e", 'on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run', title, body], check=True, timeout=10)


def account_kind(account):
    if not isinstance(account, str):
        return None
    match = re.fullmatch(r"(claude|codex)@[A-Za-z0-9_-]{1,128}", account)
    return match.group(1) if match else None


def providers_for(payload):
    if (not isinstance(payload, dict) or payload.get("schema") not in ("openusage.limits.v1", "openusage.limits.v2")
            or not isinstance(payload.get("providers"), dict)
            or ("errors" in payload and not isinstance(payload["errors"], list))):
        raise ValueError("Invalid OpenUsage limits payload")
    if payload["schema"] == "openusage.limits.v1":
        return [(kind, kind, payload["providers"].get(kind)) for kind in ("claude", "codex")]
    result = []
    for account, provider in payload["providers"].items():
        kind = account_kind(account)
        if kind:
            if not isinstance(provider, dict):
                raise ValueError("Invalid OpenUsage account payload")
            result.append((kind, account, provider))
        elif isinstance(account, str) and account.split("@", 1)[0] in ("claude", "codex"):
            raise ValueError("Invalid OpenUsage account identifier")
    return result


def migrate(state, providers, assignments=None):
    """Bind unassigned legacy records only when the target is unambiguous."""
    bindings = state.setdefault("legacy_bindings", {})
    accounts = {kind: [account for provider_kind, account, _ in providers
                       if provider_kind == kind and account != kind]
                for kind in ("claude", "codex")}
    choices = {}
    if assignments is not None:
        for assignment in assignments:
            if not isinstance(assignment, str) or "=" not in assignment:
                raise ValueError("Invalid legacy assignment")
            kind, account = assignment.split("=", 1)
            if kind not in accounts or kind in choices or account_kind(account) != kind or account not in accounts[kind]:
                raise ValueError("Invalid legacy assignment")
            if kind in bindings:
                raise ValueError("Legacy provider already bound")
            choices[kind] = account
    else:
        for kind in accounts:
            legacy = any(f"{kind}.{window}" in state["windows"] for window in ("weekly", "session"))
            if kind not in bindings and legacy and len(accounts[kind]) > 1:
                raise ValueError("Ambiguous legacy history: assign the account explicitly")
            if kind not in bindings and len(accounts[kind]) == 1:
                choices[kind] = accounts[kind][0]
    for kind, account in choices.items():
        for window in ("weekly", "session"):
            if f"{kind}.{window}" in state["windows"] and f"{account}.{window}" in state["windows"]:
                raise ValueError("Legacy history destination collision")
    for kind, account in choices.items():
        for window in ("weekly", "session"):
            source, target = f"{kind}.{window}", f"{account}.{window}"
            if source in state["windows"]:
                state["windows"][target] = state["windows"].pop(source)
        bindings[kind] = account
    state["version"] = 3


def validate_state(state):
    if not isinstance(state, dict) or state.get("version") not in (1, 2, 3) or not isinstance(state.get("windows"), dict):
        raise ValueError("Invalid OpenUsage state")
    bindings = state.get("legacy_bindings", {})
    if (not isinstance(bindings, dict) or
            any(kind not in ("claude", "codex") or account_kind(account) != kind
                for kind, account in bindings.items())):
        raise ValueError("Invalid OpenUsage legacy bindings")
    for key, item in state["windows"].items():
        account, separator, window = key.rpartition(".") if isinstance(key, str) else ("", "", "")
        if (not separator or window not in ("weekly", "session") or
                (account not in ("claude", "codex") and not account_kind(account)) or not isinstance(item, dict)):
            raise ValueError("Invalid OpenUsage window state")
        if not {"reset", "samples", "pending", "risk_alert", "exhausted"} <= item.keys():
            raise ValueError("Incomplete OpenUsage window state")
        if not number(item.get("reset")) or not isinstance(item.get("samples"), list) or len(item["samples"]) > MAX_SAMPLES:
            raise ValueError("Invalid OpenUsage samples")
        previous = None
        for sample in item["samples"]:
            if (not isinstance(sample, list) or len(sample) != 2 or not all(number(x) for x in sample)
                    or sample[1] < 0 or (previous is not None and sample[0] <= previous)):
                raise ValueError("Invalid OpenUsage sample")
            previous = sample[0]
        pending = item.get("pending")
        if pending is not None and (not isinstance(pending, dict) or not number(pending.get("since")) or not isinstance(pending.get("count"), int) or isinstance(pending.get("count"), bool) or pending["count"] < 1):
            raise ValueError("Invalid OpenUsage pending alert")
        alert = item.get("risk_alert")
        if alert is not None and (not isinstance(alert, dict) or not all(number(alert.get(k)) for k in ("at", "overshoot", "early"))):
            raise ValueError("Invalid OpenUsage alert")
        if not isinstance(item.get("exhausted", False), bool):
            raise ValueError("Invalid OpenUsage exhaustion state")
        legacy_samples = item.get("legacy_samples", [])
        if not isinstance(legacy_samples, list) or len(legacy_samples) > MAX_SAMPLES:
            raise ValueError("Invalid OpenUsage legacy samples")
        previous_legacy = None
        for sample in legacy_samples:
            if (not isinstance(sample, list) or len(sample) != 2 or not all(number(x) for x in sample)
                    or sample[1] < 0 or (previous_legacy is not None and sample[0] <= previous_legacy)):
                raise ValueError("Invalid OpenUsage legacy sample")
            previous_legacy = sample[0]
        metadata = item.get("metadata")
        if metadata is not None and (not isinstance(metadata, dict) or
                not number(metadata.get("window")) or metadata["window"] <= 0 or
                not isinstance(metadata.get("plan"), str) or
                not re.fullmatch(r"[0-9a-f]{64}", metadata["plan"])):
            raise ValueError("Invalid OpenUsage window metadata")
        cycles = item.get("cycles", [])
        if not isinstance(cycles, list) or len(cycles) > MAX_CYCLES:
            raise ValueError("Invalid OpenUsage cycle history")
        last_reset = None
        for cycle in cycles:
            if (metadata is None or not isinstance(cycle, dict) or
                    not all(number(cycle.get(k)) for k in ("reset", "rate", "span")) or
                    cycle["rate"] < 0 or cycle["span"] < 0 or
                    not isinstance(cycle.get("readings"), int) or isinstance(cycle["readings"], bool) or
                    cycle["readings"] < 3 or cycle["span"] < confidence_span(window, metadata["window"]) or
                    cycle["reset"] >= item["reset"] or
                    (last_reset is not None and cycle["reset"] <= last_reset)):
                raise ValueError("Invalid OpenUsage cycle")
            last_reset = cycle["reset"]


def save_state(directory, state):
    fd, name = tempfile.mkstemp(prefix=".state-", dir=directory)
    try:
        with os.fdopen(fd, "w") as file:
            json.dump(state, file, separators=(",", ":"), allow_nan=False)
            file.flush()
            os.fsync(file.fileno())
        os.replace(name, directory / "state.json")
    finally:
        if os.path.exists(name):
            os.unlink(name)


def confidence_span(kind, window):
    return 6 * HOUR if kind == "weekly" else min(HOUR, window / 4)


def forecast(samples, used, fetched, reset, window, kind="weekly", cycles=()):
    elapsed = fetched - (reset - window)
    if elapsed <= 0 or elapsed > window or not samples or samples[0][0] < reset - window:
        return None
    span = samples[-1][0] - samples[0][0]
    ready = len(samples) >= 3 and span >= confidence_span(kind, window)
    prior = sum(cycle["rate"] for cycle in cycles) / len(cycles) if cycles else None
    current_rate = None
    if ready:
        observed = max(0, (used - samples[0][1]) / span)
        current_rate = (used / elapsed + observed) / 2
    rate = (current_rate * .75 + prior * .25 if prior is not None else current_rate) if ready else prior
    remaining = max(0, 1 - used)
    unit = DAY if kind == "weekly" else HOUR
    available = remaining / ((reset - fetched) / unit)
    result = {"available": available, "rate": rate, "ready": ready, "prior": prior is not None,
              "span": span, "required": confidence_span(kind, window), "readings": len(samples)}
    if rate is None:
        return result
    projected = used + rate * (reset - fetched)
    early = max(0, (reset - fetched) - remaining / rate) if rate > 0 else 0
    reduction = max(0, 1 - (remaining / (reset - fetched)) / rate) if rate > 0 else 0
    result.update(overshoot=projected - 1, early=early, reduction=reduction)
    return result


def render(payload, state, now, notifier, commit):
    providers = providers_for(payload)
    rows = [["summary", "AI forecast", "normal"]]
    stale_any = False
    found = False
    fetched_times = []
    for provider_kind, name, provider in providers:
        title = "Claude" if provider_kind == "claude" else "Codex"
        if name != provider_kind and isinstance(provider, dict):
            display = clean(provider.get("displayName"))
            if display != DASH:
                title = display
        state_account = state.get("legacy_bindings", {}).get(provider_kind, name) if name == provider_kind else name
        if not isinstance(provider, dict):
            rows.append(["provider", name, title, DASH, DASH, "unavailable", "off"])
            for kind in ("weekly", "session"):
                rows.append(["resource", f"{name}.{kind}", kind.title(), DASH, DASH, "unavailable", "off"])
                rows.append(["forecast", f"{name}.{kind}", "Forecast", DASH, DASH, "unavailable", "off"])
            continue
        fetched = timestamp(provider.get("fetchedAt"))
        expiry = timestamp(provider.get("expiresAt"))
        fresh = (provider.get("stale") is not True and fetched is not None and fetched <= now
                 and (expiry > now if expiry is not None else
                      provider.get("expiresAt") is None and now - fetched <= 900))
        stale_any |= not fresh
        if fresh:
            fetched_times.append(fetched)
        plan = clean(provider.get("plan"))
        if not fresh:
            plan = "Stale" if plan == DASH else "Stale · " + plan
        rows.append(["provider", name, title, plan, DASH, "normal" if fresh else "unavailable", "on"])
        resources = provider.get("resources")
        resources = resources if isinstance(resources, dict) else {}
        for kind in ("weekly", "session"):
            key = f"{name}.{kind}"
            resource = resources.get(kind)
            if not isinstance(resource, dict) or resource.get("kind") != "consumption" or not number(resource.get("utilization")) or resource["utilization"] < 0:
                rows.append(["resource", key, kind.title(), DASH, DASH, "unavailable", "off"])
                rows.append(["forecast", key, "Forecast", DASH, DASH, "unavailable", "off"])
                continue
            found = True
            used = resource["utilization"]
            reset = timestamp(resource.get("resetsAt"))
            window = resource.get("windowSeconds")
            valid_window = number(window) and window > 0
            raw_plan = provider.get("plan")
            metadata = ({"window": window, "plan": hashlib.sha256(raw_plan.strip().encode("utf-8")).hexdigest()}
                        if valid_window and isinstance(raw_plan, str) and raw_plan.strip() else None)
            usable = fresh and reset is not None and reset > now and fetched < reset
            item = state["windows"].get(f"{state_account}.{kind}")
            changed_profile = (item is not None and metadata is not None and item.get("metadata") is not None
                               and item["metadata"] != metadata)
            if usable and item and item["samples"]:
                last_fetch = item["samples"][-1][0]
                if (fetched < last_fetch or
                        (fetched == last_fetch and (item["reset"] != reset or item["samples"][-1][1] != used)) or
                        (reset < item["reset"] and not (changed_profile and fetched > last_fetch))):
                    usable = False
            reset_text = "Reset unknown" if reset is None else "Awaiting reset" if reset <= now else "Resets in " + duration(reset - now)
            filled = min(8, int(min(1, used) * 8 + .5))
            meter = "▰" * filled + "▱" * (8 - filled) + f" {used * 100:.0f}%"
            severity = "unavailable" if not usable else "red" if used >= 1 else "normal"
            rows.append(["resource", key, kind.title(), meter, reset_text, severity, "on"])
            result = None
            new_sample = False
            if usable:
                counter_dropped = bool(item and item["reset"] == reset and item["samples"]
                                       and fetched > item["samples"][-1][0]
                                       and item["samples"][-1][1] - used > .01 + 1e-12)
                if item is None or item["reset"] != reset:
                    cycles = []
                    if item is not None and metadata is not None and item.get("metadata") == metadata:
                        cycles = list(item.get("cycles", []))
                        old_samples = item["samples"]
                        if (old_samples and fetched >= item["reset"] and
                                reset - window >= item["reset"] and old_samples[-1][0] <= item["reset"]):
                            old = forecast(old_samples, old_samples[-1][1], old_samples[-1][0],
                                           item["reset"], window, kind)
                            if old and old["ready"] and number(old["rate"]):
                                cycles.append({"reset": item["reset"], "rate": old["rate"],
                                               "span": old["span"], "readings": old["readings"]})
                                cycles = cycles[-MAX_CYCLES:]
                    legacy_samples = item.get("legacy_samples", []) if item is not None else []
                    if item is not None and "metadata" not in item:
                        legacy_samples = item["samples"]
                    item = {"reset": reset, "samples": [], "pending": None, "risk_alert": None,
                            "exhausted": False, "metadata": metadata, "cycles": cycles}
                    if legacy_samples:
                        item["legacy_samples"] = legacy_samples
                    state["windows"][f"{state_account}.{kind}"] = item
                elif ("metadata" not in item or
                      (item.get("metadata") != metadata and
                       (not item["samples"] or fetched > item["samples"][-1][0]))):
                    # Retain unprovenanced legacy samples without mixing them into a rate.
                    if "metadata" not in item and item["samples"]:
                        item["legacy_samples"] = item["samples"]
                    item.update(metadata=metadata, cycles=[], samples=[], pending=None)
                    if changed_profile:
                        item.update(risk_alert=None, exhausted=False)
                samples = item["samples"]
                if not samples or fetched > samples[-1][0]:
                    if counter_dropped:
                        item.update(samples=[], pending=None, risk_alert=None, exhausted=False)
                        samples = item["samples"]
                    samples.append([fetched, used])
                    samples[:] = [sample for sample in samples if sample[0] >= fetched - DAY][-MAX_SAMPLES:]
                    new_sample = True
                # Old snapshots cannot update projections or trigger notifications.
                current = bool(samples and fetched == samples[-1][0] and used == samples[-1][1])
                if current and used >= 1 and not item["exhausted"]:
                    notifier(f"{title} {kind} quota exhausted", "Your quota is exhausted until the scheduled reset.")
                    item["exhausted"] = True
                    commit()
                if valid_window and current and item.get("metadata") == metadata:
                    compatible_cycles = item.get("cycles", []) if metadata is not None and item.get("metadata") == metadata else []
                    result = forecast(samples, used, fetched, reset, window, kind, compatible_cycles)
                    if kind == "weekly" and result and not result["ready"] and new_sample:
                        item["pending"] = None
                    if kind == "weekly" and result and result["ready"]:
                        risk = result["overshoot"] >= .05 - 1e-12 and result["early"] >= 6 * HOUR
                        recovered = result["overshoot"] <= .02 + 1e-12 or result["early"] < 3 * HOUR
                        if new_sample and recovered:
                            item["pending"] = None
                        elif risk:
                            pending = item["pending"]
                            if pending is None and new_sample:
                                pending = item["pending"] = {"since": fetched, "count": 0}
                            if pending is not None and new_sample:
                                pending["count"] += 1
                            prior = item["risk_alert"]
                            allowed = prior is None or (fetched - prior["at"] >= DAY and (result["overshoot"] >= prior["overshoot"] + .10 - 1e-12 or result["early"] >= prior["early"] + 6 * HOUR))
                            if pending is not None and used < 1 and pending["count"] >= 3 and fetched - pending["since"] >= 1800 and allowed:
                                notifier(f"{title} weekly quota forecast", f"May run out ~{duration(result['early'])} early. Reduce usage ~{round(result['reduction'] * 100)}% to last until reset.")
                                item["risk_alert"] = {"at": fetched, "overshoot": result["overshoot"], "early": result["early"]}
                                commit()
            if usable and used >= 1:
                value, detail, color = "Quota exhausted", "No quota remaining", "red"
            elif not usable or not valid_window or result is None:
                value, detail, color = "Forecast unavailable", DASH, "unavailable"
            else:
                unit = "day" if kind == "weekly" else "hour"
                progress = (f"Observed this cycle: {result['readings']} fresh readings across {result['span'] / HOUR:.1f} elapsed hours"
                            if result["ready"] else
                            f"Learning: {result['readings']}/3 fresh readings; {result['span'] / HOUR:.1f}/{result['required'] / HOUR:.1f} elapsed hours")
                allowance = (f"Remaining until reset: approximately {max(0, 1 - used) * 100:.1f} quota points"
                             if reset - now < (DAY if kind == "weekly" else HOUR) else
                             f"Allowance: approximately {result['available'] * 100:.1f} quota points/{unit}")
                detail = f"{allowance} · {progress}"
                if result["rate"] is None:
                    value, color = "Learning your pace", "normal"
                else:
                    count = len(item.get("cycles", []))
                    source = (f"Provisional estimate from {count} previous cycle(s)" if not result["ready"]
                              else f"Based on this cycle and {count} previous cycle(s)" if result["prior"]
                              else "Based on this cycle")
                    scale = DAY if kind == "weekly" else HOUR
                    detail += f" · Estimated pace: approximately {result['rate'] * scale * 100:.1f} quota points/{unit} · {source}"
                    if result["overshoot"] > 0:
                        value = f"~{duration(reset - fetched - result['early'])} left · ~{duration(result['early'])} before reset"
                        detail += f" · Reduce estimated pace ~{result['reduction'] * 100:.0f}%"
                        color = "yellow" if result["overshoot"] >= .05 - 1e-12 and (kind == "session" or result["early"] >= 6 * HOUR) else "normal"
                    else:
                        value, color = "Likely lasts until reset", "normal"
                    if not result["ready"]:
                        value = "Provisional · " + value
            rows.append(["forecast", key, "Forecast", value, detail, color, "on"])
    errors = bool(payload.get("errors"))
    if stale_any:
        status, color = "Stale data · open OpenUsage", "unavailable"
    elif not found:
        status, color = ("Provider error" if errors else "No usage data"), "unavailable"
    else:
        age = now - min(fetched_times)
        status = ("Partial data · " if errors else "") + "Updated " + ("just now" if age < 60 else f"{int(age // 60)}m ago")
        color = "yellow" if errors else "normal"
    rows.append(["status", status, color])
    return rows


def process(payload, state_dir, now=None, notifier=notify, preview=False, assign_legacy=None):
    """Process a snapshot; preview and explicit migration never notify."""
    now = time.time() if now is None else now
    if not number(now):
        raise ValueError("Invalid current time")
    providers = providers_for(payload)
    if assign_legacy is not None and (preview or payload["schema"] != "openusage.limits.v2"):
        raise ValueError("Legacy assignment requires a v2 payload and cannot be previewed")
    directory = Path(state_dir)
    if preview:
        # State replacement is atomic; reading without creating or changing a lock
        # keeps preview strictly read-only.
        try:
            with (directory / "state.json").open() as file:
                state = json.load(file)
        except FileNotFoundError:
            state = {"version": 1, "windows": {}}
        else:
            validate_state(state)
        migrate(state, providers)
        return render(payload, state, now, lambda *_: None, lambda: None)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    lock_fd = os.open(directory / "state.lock", os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(lock_fd, "r+") as lock:
        os.fchmod(lock.fileno(), 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = directory / "state.json"
        try:
            with path.open() as file:
                state = json.load(file)
        except FileNotFoundError:
            state = {"version": 1, "windows": {}}
        else:
            validate_state(state)
        migrate(state, providers, assign_legacy)
        if path.exists():
            os.chmod(path, 0o600)
        if assign_legacy is not None:
            save_state(directory, state)
            return [["migration", "Legacy history assigned"]]
        try:
            rows = render(payload, state, now, notifier, lambda: save_state(directory, state))
        except Exception:
            # Keep observations and any earlier successful dispatches, never failed dedup.
            save_state(directory, state)
            raise
        save_state(directory, state)
        return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--now", type=float)
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--assign-legacy", action="append", metavar="PROVIDER=ACCOUNT_ID")
    args = parser.parse_args()
    try:
        payload = json.load(sys.stdin)
        rows = process(payload, args.state_dir, args.now, preview=args.preview, assign_legacy=args.assign_legacy)
        for row in rows:
            print("\t".join(row))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"OpenUsage: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
