# Native quota alerts: evaluation and integration

## Verdict and scope

Keep alerts as a first-class AI Forecast feature. OpenUsage's native alerts are a useful alternative, but its supported CLI is a quota-data source, not an externally callable alert engine or notification relay. Reusing alert categories is possible; silently delegating our existing forecasting and delivery guarantees is not.

This assessment examines OpenUsage **v0.8.0**, the AI Forecast implementation at release **2890d50**, and the then-installed Raycast API **2.12.0** declarations. It combines two independent source investigations with synthetic arithmetic. At assessment time, no OpenUsage upgrade, GUI launch, account access, notification test, or alert-setting change was performed, and the installed OpenUsage was observed to be **0.7.16**, not 0.8.0. Native 0.8 behavior below is source-confirmed, not a claim of end-to-end notification delivery on this Mac.

The resulting TypeScript migration is tracked in [#1](https://github.com/Thomasevano/raycast-ai-forecast/issues/1). Optional threshold alerts ([#2](https://github.com/Thomasevano/raycast-ai-forecast/issues/2)) and unused-quota reminders ([#3](https://github.com/Thomasevano/raycast-ai-forecast/issues/3)) remain deferred.

## What OpenUsage actually implements

The [settings documentation](https://github.com/robinebers/openusage/blob/v0.8.0/docs/settings.md#alerts), [transition policy](https://github.com/robinebers/openusage/blob/v0.8.0/Sources/OpenUsage/Support/PaceNotificationLogic.swift), and [notification evaluator](https://github.com/robinebers/openusage/blob/v0.8.0/Sources/OpenUsage/Stores/QuotaNotificationEvaluator.swift) establish these categories:

| Category | Rule | Rearming / qualification |
| --- | --- | --- |
| Warning | Remaining quota reaches the configured warning threshold; default 30% | Rearms after returning to normal severity |
| Critical | Remaining quota reaches the configured critical threshold; default 10% | Rearms after leaving critical severity; a jump across both levels sends the lowest enabled one, not both |
| Burning Fast | Projected use runs out before reset, including the near-limit rounding boundary | Rearms only when projected use eases to at most 90% of the full quota |
| Use It or Lose It | More than 50% remains after whole-percent rounding, and reset is within the next 24 hours | Once per reset window; only bounded, non-dollar limits with a known window longer than one day |

Notification switches are opt-in, independent of the Priority-list switches. There is **no separate exact-100%-exhaustion milestone** in this evaluator: a spent limit contributes to the existing severity/pace state. An earlier Critical or Burning Fast warning therefore does not imply a new notification precisely at exhaustion.

### Pace is an elapsed-window average, not a learned trend

[`Pace.evaluate`](https://github.com/robinebers/openusage/blob/v0.8.0/Sources/OpenUsage/Support/Pace.swift) computes:

- elapsed share = elapsed time since `resetsAt - periodDuration`, divided by the whole window;
- projected use at reset = current used quota / elapsed share.

It waits for both one minute and 1% of the window to elapse: approximately 1 hour 41 minutes for a seven-day window, or three minutes for a five-hour window. It does not require several distinct readings or keep previous-cycle usage rates. [`WidgetData`](https://github.com/robinebers/openusage/blob/v0.8.0/Sources/OpenUsage/Models/WidgetData.swift) additionally suppresses untouched sessions and non-healthy pace below 5% used. An on-track projection with less than one whole percent of displayed headroom is classified as running out.

This is a useful, explainable linear projection, not a calibrated probability. A short early burst can dominate it; a recent acceleration after several quiet days can remain hidden by the earlier average.

### Reliability and quiet-use limits

- **Cold-start priming:** the first non-missing observation establishes the baseline without notifying, even if already critical or running out. Already-crossed conditions can consequently go unannounced after launch. The Use It or Lose It milestone is also marked on this initial observation if already eligible. Alert transitions and fired milestones live in memory, not durable history. Restarting loses that state. ([Policy](https://github.com/robinebers/openusage/blob/v0.8.0/Sources/OpenUsage/Support/PaceNotificationLogic.swift), [evaluator](https://github.com/robinebers/openusage/blob/v0.8.0/Sources/OpenUsage/Stores/QuotaNotificationEvaluator.swift))
- **Failed delivery is retryable:** disabled, denied, or failed notification dispatch does not consume the relevant transition. Successful dispatch marks it; it does not prove a banner appeared. Native posting uses macOS UserNotifications, a default sound, and a fresh UUID per request. ([Evaluator](https://github.com/robinebers/openusage/blob/v0.8.0/Sources/OpenUsage/Stores/QuotaNotificationEvaluator.swift), [sender](https://github.com/robinebers/openusage/blob/v0.8.0/Sources/OpenUsage/Support/AppNotifications.swift))
- **Metrics hidden in OpenUsage are excluded:** `AppContainer` evaluates `layout.visibleDescriptors`; that property filters hidden metrics out of the display groups. Closing the panel or removing quota figures from a different app's bar is not the same action as hiding the metric in OpenUsage's layout. ([Refresh loop](https://github.com/robinebers/openusage/blob/v0.8.0/Sources/OpenUsage/App/AppContainer.swift), [visible descriptors](https://github.com/robinebers/openusage/blob/v0.8.0/Sources/OpenUsage/Stores/LayoutStore+Customization.swift))
- **Cached data is still eligible in the inspected native path:** a failed provider refresh records a backoff without removing the last good snapshot. `data(for:)` resolves that cached snapshot without an age guard; the notification evaluator does not check its fetched time or expiry. Staleness notices are a separate UI path. Thus this is not equivalent to AI Forecast's fresh-reading-only alert gate. Inference from that flow: a time-based Use It or Lose It condition can become eligible while its usage value is old. ([Data store](https://github.com/robinebers/openusage/blob/v0.8.0/Sources/OpenUsage/Stores/WidgetDataStore.swift), [evaluator](https://github.com/robinebers/openusage/blob/v0.8.0/Sources/OpenUsage/Stores/QuotaNotificationEvaluator.swift))
- **The app must remain running:** evaluation follows the app's scheduled usage-refresh passes, not whether the popover is open. The documented cadence is five minutes; refresh failures, request durations, sleep, app termination and macOS notification settings limit timeliness. A successful system enqueue is not proof of on-screen delivery. ([Refresh documentation](https://github.com/robinebers/openusage/blob/v0.8.0/docs/refreshing.md), [app container](https://github.com/robinebers/openusage/blob/v0.8.0/Sources/OpenUsage/App/AppContainer.swift))

## Comparison with AI Forecast

The [original forecast engine at the assessed release](https://github.com/Thomasevano/raycast-ai-forecast/blob/2890d5064f9cf88c6beabc204b141ab96d1166b3/assets/openusage-model.py) requires three fresh weekly readings spanning six hours before a learned weekly risk alert. Its rate combines the current-window average with the observed recent slope, and optionally eligible previous cycles. A warning additionally needs at least five quota points of projected overshoot and six hours of early exhaustion, sustained for 30 minutes across three distinct fresh readings. Repeat risk warnings require at least 24 hours and material worsening. Exhaustion has its own durable, fresh-reading-only, once-per-window notification. Opening the view does not collect samples or send alerts.

This makes our policy more conservative about short-lived changes, **not universally better**: it can withhold an early warning during its initial learning period. It is still a heuristic, not a promise about future usage. It currently sends forecast-risk alerts for Weekly only; Session has projections and exhaustion alerts, not its own risk-alert category.

### Synthetic arithmetic verification

The following calculations used the assessed release's actual pure Python `confidence_span` and `forecast` functions, extracted by AST, without invoking processing, persistence or notification dispatch. They are evidence from that assessment, not an execution of the later TypeScript port. The native column applies the inspected Swift formula and its elapsed-time gate; the Swift app itself was not executed. All examples use a 168-hour window, a 100-point quota, no prior-cycle rates, and times relative to the window start.

| Hypothetical readings | Native projected total | AI Forecast projected total | Interpretation |
| --- | --- | --- | --- |
| 15% used after 2 hours, one reading | 1260% | Learning | Native pace is running out; our weekly model is not ready |
| 20% at hours 12, 15 and 18, no recent consumption | 186.67% | 103.33% | Native pace is running out; our projection does not meet the five-point overshoot gate |
| 20%, 30%, 40% at hours 120, 123 and 126 | 53.33% | 116.67% | Native pace is healthy; our recent trend is a risk candidate, with exhaustion about 9.13 hours early |

These are **pace classifications and risk candidates, not delivered alerts**. Native cold-start/transition rules and our sustained-evidence rules still apply. Assertions for these contrasting outcomes passed in the throwaway calculation; no permanent test or runtime behavior was changed.

## Can the extension reuse the native alerts?

### Supported integration: quota data only

The [CLI contract](https://github.com/robinebers/openusage/blob/v0.8.0/docs/cli.md) and [CLI entrypoint](https://github.com/robinebers/openusage/blob/v0.8.0/Sources/OpenUsageCLI/OpenUsageCLI.swift) expose cached quota readings, not alert events, rule configuration, an evaluator command, or a notification-send command. No supported external alert interface was found in the reviewed v0.8.0 docs/source; this is not proof that every conceivable private interface is absent.

There is a SwiftPM library product, but the inspected evaluator and sender are internal Swift types, not a stable external API. TypeScript cannot simply import that internal Swift engine. The [MIT license](https://github.com/robinebers/openusage/blob/v0.8.0/LICENSE) permits adapting code with its required copyright/license notice; copied implementation must preserve that notice. Porting a rule is a deliberate policy change, not calling a public OpenUsage service. ([Package definition](https://github.com/robinebers/openusage/blob/v0.8.0/Package.swift))

Do not mutate OpenUsage's private preferences, copy its credentials, modify its app bundle, or impersonate its notification identity to implement integration.

### Notification delivery is a separate concern

Raycast's documented [`showToast`](https://developers.raycast.com/api-reference/feedback/toast) and [`showHUD`](https://developers.raycast.com/api-reference/feedback/hud) are UI feedback, not a Notification Center delivery API. Toasts fall back to HUD when the Raycast window is closed; HUD closes Raycast's main window. The installed API 2.12.0 declarations expose these helpers but no native notification-center API. They are not an equivalent replacement for retained background quota notifications.

Our [notification sender](../src/notifications.ts) retains `osascript`, attributed to Script Editor. A TypeScript port alone does not change that attribution. Apple provides [`UNUserNotificationCenter`](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter) and [bundle identifiers](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleidentifier), so a separate correctly bundled/signed helper with its own authorization is a possible native-delivery project. Its packaging, attribution, authorization, lifecycle, and Raycast distribution compatibility remain unverified; it is not a capability already available through this extension or OpenUsage's CLI.

## Recommended product direction — not implemented by this assessment

1. **Keep extension-owned alerts and port the existing engine to TypeScript without silently replacing its behavior.** Preserve historical state, permissions, concurrency safety, preview isolation, freshness checks and successful-dispatch deduplication. Removing Python simplifies installation, not the forecasting mathematics or macOS notification identity.
2. **Keep the quiet default:** with monitoring explicitly enabled, warn about sustained weekly risk and actual fresh exhaustion. Consider Warning/Critical as optional controls, not another always-visible percentage or default stream of threshold alerts.
3. **Use It or Lose It can be an opt-in extension feature.** Keep it off by default: reminding someone to consume an unused allowance can work against their goal of forgetting the meter. Exclude sessions and paid spending caps, require fresh data, and persist once-per-window deduplication.
4. **Choose one alert owner per overlapping category.** If our extension owns weekly risk/exhaustion, disable overlapping OpenUsage Notify switches manually. We cannot inspect or change those switches through its supported CLI, so do not claim automatic cross-app deduplication. Delegating delivery to OpenUsage would be an explicit, user-configured alternative, not transparent integration.
5. **Do not equate pausing our monitor with handing over delivery.** The current [monitor](../src/monitor.ts) also builds our forecast history. A future delegation mode must separate sample collection from alert sending, rather than stopping learning or silently consuming notification flags.
6. **Keep notification transport distinct from policy.** Retain the working sender unless/until an independently packaged native channel is implemented and verified with explicit notification-test permission. Do not substitute a toast/HUD for a persistent background alert or label helper feasibility as Store approval.

The original assessment changed only this research note, not product behavior, installed apps, real history or settings. The later TypeScript implementation is a separate change tracked by #1; it does not implement the deferred alert categories or submit to the Store.
