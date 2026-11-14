# OpenUsage compatibility assessment

## Reviewed contracts

The latest public release inspected was OpenUsage 0.8.0, published on 2026-11-12 ([release](https://github.com/robinebers/openusage/releases/tag/v0.8.0)). The comparison uses immutable source revisions: [0.8.0, `35e88e9`](https://github.com/robinebers/openusage/tree/35e88e93bff8b808a84c3dce1cef9c6fb1219156) and [0.7.16, `abf472d`](https://github.com/robinebers/openusage/tree/abf472d5dbb23645c3afbb5a0c7429606ffbdcd7).

| Version        | Selected transport                                                                       | Important boundary                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.8.0          | Bundled or installed CLI, no arguments                                                   | Cached `openusage.limits.v2`; no refresh, credential read or app launch.                                                                    |
| 0.7.16         | Local cached HTTP `/v1/limits`                                                           | `openusage.limits.v1` can contain both `codex` and `codex@…` / `claude@…` cards. Do not run its CLI usage command.                          |
| Other releases | CLI for recognized 0.8+ versions; cached HTTP for recognized older versions or no helper | Contract-based compatibility, not an individually tested release list. Unknown helper versions and unsupported payload schemas fail closed. |

Both reviewed [CLI entrypoints](https://github.com/robinebers/openusage/blob/35e88e93bff8b808a84c3dce1cef9c6fb1219156/Sources/OpenUsageCLI/OpenUsageCLI.swift) handle `--version` before constructing account settings or usage readers ([0.7.16 entrypoint](https://github.com/robinebers/openusage/blob/abf472d5dbb23645c3afbb5a0c7429606ffbdcd7/Sources/OpenUsageCLI/OpenUsageCLI.swift)). In contrast to 0.8, the [0.7.16 usage reader](https://github.com/robinebers/openusage/blob/abf472d5dbb23645c3afbb5a0c7429606ffbdcd7/Sources/OpenUsage/Services/UsageReader.swift) may refresh stale or missing caches, capture the login-shell environment and read account identities or credentials. This is why transport selection happens before invoking a usage command, rather than falling back after an unsafe invocation fails.

The [0.8 installer](https://github.com/robinebers/openusage/blob/35e88e93bff8b808a84c3dce1cef9c6fb1219156/Sources/OpenUsage/Services/CommandLineToolInstaller.swift) links `Contents/Helpers/openusage` from the app bundle. Executing that existing bundled helper directly avoids an unnecessary administrator-installed symlink. AI Forecast caches only its version capability and file identity in memory, not account data; executable replacement or modification invalidates that capability.

After a version probe completes, the adapter checks the file identity again and rejects a changed executable before authorizing usage. These checks are not atomic with process execution and do not pin a binary against arbitrary concurrent replacement. Helper paths must be trusted; pause monitoring before replacing or downgrading OpenUsage.

## Account and freshness semantics

The [0.7.16 account registry](https://github.com/robinebers/openusage/blob/abf472d5dbb23645c3afbb5a0c7429606ffbdcd7/Sources/OpenUsage/Stores/ProviderAccountsStore.swift) keeps the first observed account's bare family ID permanently. Later accounts receive a family-prefixed identity hash. Changing the default-source badge does not rename those records. The [HTTP serializer](https://github.com/robinebers/openusage/blob/abf472d5dbb23645c3afbb5a0c7429606ffbdcd7/Sources/OpenUsage/Services/LocalLimitsAPI.swift) exposes those card IDs, even though the envelope still says `v1`.

Account-aware v1 payloads must not automatically treat `codex` as an alias for a sibling `codex@…` card. Their histories and exhaustion flags stay separate, including when an existing v2 binding is present. Routing is recorded per provider in version 3 state. It survives the last named card disappearing and a restart, and remains intact in read-only previews without being written. Automatic v2 adoption applies only to unqualified legacy history. Confirmed v1 card identities remain separate unless the owner explicitly assigns history. Account IDs are opaque; no cross-version identity is inferred from a display name or the number of connected cards. The [README migration instructions](../README.md#migrating-version-1-history) describe the validated explicit v2 assignment path and its collision checks.

Freshness follows each provider's actual `fetchedAt`, `expiresAt` and stale flag, not a hardcoded age chosen for one release. The inspected producers use different cache expiry durations; neither a transport change nor a version probe makes an old quota reading fresh.

## Why macOS 15?

The extension supports Raycast 2 only. [Raycast's v2 release page](https://www.raycast.com/new) requires macOS Tahoe 26 and Apple Silicon; Raycast 1 is not supported. The engine's macOS 15 floor does not lower the extension's requirements.

The engine's minimum is not a TypeScript language requirement. The engine retains a BSD lock through an inherited descriptor while its complete state/notification transaction runs. Apple's [macOS 15 distribution](https://github.com/apple-oss-distributions/distribution-macOS/tree/macos-150/shell_cmds) includes `lockf` descriptor-only mode; the [macOS 14 implementation](https://github.com/apple-oss-distributions/shell_cmds/blob/e256b9a97f9bbd751305b7af36cf751668fbb849/lockf/lockf.c) does not. The [locking ADR](adr/0001-native-bsd-locking.md) records the rejected legacy-style substitute and its failed ownership probe.

OpenUsage 0.8 independently declares [macOS 15](https://github.com/robinebers/openusage/blob/35e88e93bff8b808a84c3dce1cef9c6fb1219156/Package.swift).

## Verification scope

The isolated smoke scenario used a temporary HOME, fake app bundle, synthetic cached CLI executables, a real temporary loopback HTTP server, and private temporary history. It exercised bundled-helper discovery, automatic weekly-window appearance, disconnected accounts, cached version detection and executable replacement, legacy HTTP selection, native locked writes, preview immutability and default/named account isolation. Guards prohibited execution of installed account tools or `osascript`; no account, provider service, GUI, or real notification was accessed.

The permanent Node regressions also cover unidentified helper failures, unsafe legacy-command avoidance, replacement during version probing, downgrade isolation, persistent routing after card disappearance or restart, preservation of identified v1 history on upgrade, and the existing forecast/alert/storage invariants. Monitoring-state regressions cover boolean/numeric storage, unchanged health readings, overdue checks and error recovery. These are contract fixtures and native filesystem/locking checks on the current host. They do not establish execution of official OpenUsage binaries on every supported macOS version. Raycast 2's native view and background scheduler could not be reverified because the running test VM reported no available guest display. Notification Center presentation also remains unverified. Optional threshold and unused-quota alert features remain deferred.
