# AI Forecast changelog

## [Unreleased]

- Run forecasts and quiet alerts in TypeScript without a Python installation or executable preference.
- Preserve existing history, account bindings, forecast rules and alert deduplication, using native BSD locks on macOS 15 or newer for concurrent checks.
- Provide a TypeScript history-assignment command for ambiguous legacy accounts; notification delivery remains attributed to Script Editor.
- Detect OpenUsage's bundled helper without requiring its administrator-installed CLI link; cache version detection until the executable changes and reject changes during probing.
- Use cached CLI reads for OpenUsage 0.8+, but cached HTTP for recognized older helpers, never invoking their credential-reading usage command.
- Preserve separate default/named-card history and alerts in legacy HTTP snapshots, including downgrades from v2 data, disappearing cards and restarts; do not guess identified v1 card ownership on upgrade.
- Require Raycast 2 on macOS Tahoe 26 or newer and Apple Silicon; the standalone engine retains its macOS 15 locking requirement.
- Keep monitoring status consistent with native boolean/numeric storage and update health only when readings, errors or overdue status change.

## [Initial release] - 2026-11-13

- Show Claude and Codex weekly and Session forecasts, with allowance per day or hour and a distinct estimated pace.
- Read cached OpenUsage 0.8 CLI snapshots, with a legacy 0.7.x local HTTP fallback.
- Keep accounts, quota types and plan/window profiles separate; retain up to four sufficiently observed previous-cycle rates and preserve legacy numeric history and notification deduplication.
- Send quiet alerts for sustained weekly risk or quota exhaustion, with monitoring paused until enabled.
- Show two optional community reset sources and their values inline, without treating an uncalibrated signal score as a probability or adding speculative resets to allowance.
- Credit and link public sources in their detail views, explain their calculations and limits, and respect one-minute caching and HTTP 429 retry delays.
