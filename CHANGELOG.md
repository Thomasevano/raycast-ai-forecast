# AI Forecast Changelog

## [Initial Release] - 2026-11-13

- Show Claude and Codex weekly and Session forecasts, with allowance per day or hour and a distinct estimated pace.
- Read cached OpenUsage 0.8 CLI snapshots, with a legacy 0.7.x local HTTP fallback.
- Keep accounts, quota types and plan/window profiles separate; retain up to four sufficiently observed previous-cycle rates and preserve legacy numeric history and notification deduplication.
- Send quiet alerts for sustained weekly risk or quota exhaustion, with monitoring paused until enabled.
- Show two optional community reset sources and their values inline, without treating an uncalibrated signal score as a probability or adding speculative resets to allowance.
- Credit and link public sources in their detail views, explain their calculations and limits, and respect one-minute caching and HTTP 429 retry delays.
