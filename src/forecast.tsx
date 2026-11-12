import {
  Action,
  ActionPanel,
  Cache,
  Color,
  environment,
  getPreferenceValues,
  Icon,
  launchCommand,
  LaunchType,
  List,
  LocalStorage,
  openExtensionPreferences,
  showToast,
  Toast,
  Keyboard,
} from "@raycast/api";
import { useEffect, useState } from "react";
import {
  openOpenUsage,
  openOutlook,
  readForecast,
  readOutlooks,
  sendTestNotification,
  STATE_DIRECTORY,
  type Outlook,
  type Snapshot,
} from "./quota";

const colors = {
  normal: Color.SecondaryText,
  yellow: Color.Yellow,
  red: Color.Red,
  unavailable: Color.SecondaryText,
};

const resetCache = new Cache({ namespace: "community-reset-signals-v1" });

async function perform(
  action: () => Promise<void>,
  title: string,
): Promise<void> {
  try {
    await action();
    await showToast({ style: Toast.Style.Success, title });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Action failed",
      message: error instanceof Error ? error.message : "Please try again.",
    });
  }
}

function ForecastActions(props: {
  onRefresh: () => void;
  onToggleMonitoring: () => Promise<void>;
  monitoring: boolean | undefined;
  monitorFirst?: boolean;
}) {
  const refresh = (
    <Action
      title="Refresh Forecast"
      icon={Icon.ArrowClockwise}
      shortcut={Keyboard.Shortcut.Common.Refresh}
      onAction={props.onRefresh}
    />
  );
  const monitor = (
    <Action
      title={props.monitoring ? "Pause Monitoring" : "Start Monitoring"}
      icon={props.monitoring ? Icon.Pause : Icon.Play}
      onAction={props.onToggleMonitoring}
    />
  );
  return (
    <ActionPanel>
      <ActionPanel.Section>
        {props.monitorFirst ? monitor : refresh}
        {props.monitorFirst ? refresh : monitor}
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action
          title="Open OpenUsage"
          icon={Icon.AppWindow}
          onAction={() =>
            perform(openOpenUsage, "OpenUsage opened in background")
          }
        />
        <Action
          title="Send Test Notification"
          icon={Icon.Bell}
          onAction={() =>
            perform(
              sendTestNotification,
              "Notification submitted — check Script Editor notifications",
            )
          }
        />
        <Action
          title="Extension Preferences"
          icon={Icon.Gear}
          onAction={openExtensionPreferences}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

interface MonitorHealth {
  enabled?: boolean;
  last?: number;
  error?: string;
  checkedAt: number;
}

export default function Forecast() {
  const { pythonPath, openusagePath, showOutlook } = getPreferenceValues<{
    pythonPath?: string;
    openusagePath?: string;
    showOutlook: boolean;
  }>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [outlooks, setOutlooks] = useState<Outlook[]>([]);
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [health, setHealth] = useState<MonitorHealth>(() => ({
    checkedAt: Date.now(),
  }));
  const {
    enabled: monitoring,
    last: lastMonitor,
    error: monitorError,
  } = health;
  const [isToggling, setIsToggling] = useState(false);

  useEffect(() => {
    if (isToggling) return;
    let active = true;
    async function refreshMonitorHealth() {
      try {
        const [enabled, last, error] = await Promise.all([
          LocalStorage.getItem<boolean>("monitoring"),
          LocalStorage.getItem<number>("lastMonitorAt"),
          LocalStorage.getItem<string>("monitorError"),
        ]);
        if (active)
          setHealth({
            enabled: enabled === true,
            last,
            error,
            checkedAt: Date.now(),
          });
      } catch {
        if (active)
          setHealth({
            error:
              "Monitoring settings could not be read. Refresh to try again.",
            checkedAt: Date.now(),
          });
      }
    }
    void refreshMonitorHealth();
    const timer = setInterval(refreshMonitorHealth, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [reload, isToggling]);

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    readForecast({
      pythonPath,
      openusagePath,
      assetsPath: environment.assetsPath,
      preview: true,
      signal: controller.signal,
    })
      .then((data) => {
        if (controller.signal.aborted) return;
        setSnapshot(data);
        setError(undefined);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setSnapshot(undefined);
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not load the forecast.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [pythonPath, openusagePath, reload]);

  useEffect(() => {
    setOutlooks([]);
    if (
      !showOutlook ||
      !snapshot?.windows.some((quota) => quota.provider === "codex")
    )
      return;
    const controller = new AbortController();
    void readOutlooks(controller.signal, resetCache).then((external) => {
      if (!controller.signal.aborted) setOutlooks(external);
    });
    return () => controller.abort();
  }, [snapshot, showOutlook]);

  async function toggleMonitoring(): Promise<void> {
    if (monitoring === undefined) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Monitoring state unavailable",
        message: "Refresh before changing monitoring.",
      });
      return;
    }
    if (isToggling) return;
    setIsToggling(true);
    try {
      if (monitoring) {
        await LocalStorage.setItem("monitoring", false);
        setHealth((previous) => ({ ...previous, enabled: false }));
        await showToast({
          style: Toast.Style.Success,
          title: "Monitoring paused",
          message:
            "History is preserved. A check already in flight may still finish.",
        });
      } else {
        await LocalStorage.setItem("monitoring", true);
        try {
          await launchCommand({
            name: "monitor",
            type: LaunchType.UserInitiated,
          });
        } catch (failure) {
          await LocalStorage.setItem("monitoring", false);
          throw failure;
        }
        setHealth((previous) => ({ ...previous, enabled: true }));
      }
    } catch (failure) {
      setHealth((previous) => ({
        ...previous,
        enabled: undefined,
        error: "Monitoring state could not be changed. Refresh to check.",
      }));
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not change monitoring",
        message:
          failure instanceof Error ? failure.message : "Please try again.",
      });
    } finally {
      setIsToggling(false);
    }
  }

  const refresh = () => setReload((value) => value + 1);
  const actions = (
    <ForecastActions
      onRefresh={refresh}
      onToggleMonitoring={toggleMonitoring}
      monitoring={monitoring}
      monitorFirst={monitoring === false}
    />
  );
  const accounts = [
    ...new Set(snapshot?.windows.map((quota) => quota.accountId) ?? []),
  ];
  const ready = Boolean(snapshot || error);
  const monitoringStatus =
    monitoring === undefined
      ? "Unknown"
      : !monitoring
        ? "Paused"
        : monitorError
          ? "Needs attention"
          : !lastMonitor
            ? "Starting"
            : health.checkedAt - lastMonitor > 600_000
              ? "Last check overdue"
              : "On";
  return (
    <List
      isLoading={isLoading || isToggling}
      isShowingDetail={ready}
      searchBarPlaceholder="Filter providers, quotas or monitoring"
    >
      <List.EmptyView
        icon={isLoading ? Icon.Clock : Icon.MagnifyingGlass}
        title={isLoading ? "Loading forecast…" : "No matching items"}
        description="Try a provider, quota window or monitoring."
        actions={actions}
      />
      {ready && (error || accounts.length === 0) && (
        <List.Item
          id="unavailable"
          title={error ? "Forecast unavailable" : "No usable quota windows"}
          icon={Icon.Warning}
          detail={
            <List.Item.Detail
              markdown={`## ${error ? "Forecast unavailable" : "No usable quota windows"}\n\n${error ?? snapshot?.status}\n\nKeep OpenUsage running with its command-line helper installed, or use a compatible 0.7.x local API. Connect Claude or Codex there, then refresh. Monitoring controls remain available below.`}
            />
          }
          actions={actions}
        />
      )}
      {accounts.map((accountId) => {
        const windows = snapshot!.windows.filter(
          (quota) => quota.accountId === accountId,
        );
        return (
          <List.Section
            key={accountId}
            title={windows[0].providerName}
            subtitle={windows[0].plan}
          >
            {windows.map((quota) => {
              const forecast = quota.forecast;
              const unavailable = quota.severity === "unavailable";
              const tint =
                colors[
                  unavailable
                    ? "unavailable"
                    : (forecast?.severity ?? quota.severity)
                ];
              const summary = forecast?.summary ?? "Quota reading";
              const detail =
                forecast?.detail.split(" · ").join("\n\n") ??
                "OpenUsage has not returned the metadata needed to forecast this window.";
              const markdown = `## ${summary}\n\n${detail}\n\n**1 quota point = 1% of the full ${quota.title.toLowerCase()} allowance**, not 1% of what remains. ${quota.title === "Weekly" ? "A day means 24 elapsed hours, not a workday." : "A Session is a short-term quota window, not a conversation."}\n\nAllowance is an even-pace guideline until reset. Estimated pace is your modeled consumption rate, including idle time.${monitoring === false ? "\n\n**Monitoring is paused.** Start Monitoring to collect fresh usage history; opening this view does not build stored history." : ""}${unavailable ? "\n\n**This reading does not qualify for a current forecast or quota alert.** Check reset metadata and freshness in OpenUsage." : ""}`;
              return (
                <List.Item
                  key={quota.id}
                  id={quota.id}
                  title={quota.title}
                  icon={{
                    source: unavailable
                      ? Icon.Clock
                      : forecast?.severity === "red" ||
                          forecast?.severity === "yellow"
                        ? Icon.Warning
                        : Icon.Circle,
                    tintColor: tint,
                  }}
                  keywords={[
                    accountId,
                    quota.provider,
                    quota.providerName,
                    quota.title,
                    "quota",
                    "budget",
                    "forecast",
                  ]}
                  accessories={[
                    {
                      text: unavailable
                        ? "Unavailable"
                        : `${quota.meter.replace(/^[▰▱]+\s*/, "")} used`,
                      tooltip: unavailable
                        ? `Last reported: ${quota.meter}`
                        : "Reported quota consumption",
                    },
                  ]}
                  detail={
                    <List.Item.Detail
                      markdown={markdown}
                      metadata={
                        <List.Item.Detail.Metadata>
                          <List.Item.Detail.Metadata.Label
                            title="Reset"
                            text={quota.reset}
                          />
                          <List.Item.Detail.Metadata.Label
                            title="Snapshot"
                            text={snapshot!.status}
                          />
                          <List.Item.Detail.Metadata.Label
                            title="Quiet alerts"
                            text={monitoringStatus}
                          />
                        </List.Item.Detail.Metadata>
                      }
                    />
                  }
                  actions={actions}
                />
              );
            })}
          </List.Section>
        );
      })}
      {ready && (
        <List.Section title="Monitoring">
          <List.Item
            id="monitoring"
            title="Quiet alerts"
            icon={{ source: Icon.Bell, tintColor: Color.SecondaryText }}
            keywords={[
              "monitor",
              "monitoring",
              "notifications",
              "alerts",
              "pause",
              "start",
              "settings",
            ]}
            accessories={[{ text: monitoringStatus }]}
            detail={
              <List.Item.Detail
                markdown={`## Learn quietly in the background\n\n**Start Monitoring** to collect fresh quota readings. Opening this view only previews the forecast; it never saves samples or sends quota alerts.\n\nA new weekly model needs **3 readings spanning 6 hours**. A Session model needs **3 readings spanning 1 hour**, or one quarter of its window if shorter. These are elapsed hours, including idle time—not conversations or hours spent working.\n\nEligible previous cycles provide a provisional estimate while the current cycle learns. Allowance is an even-pace guideline; estimated pace is your modeled consumption rate.\n\nOnly sustained **weekly** risk or quota exhaustion triggers an alert. Raycast must stay running with background refresh enabled for **Monitor AI Quotas**; checks are approximately once a minute.\n\nFor banners, allow **Script Editor** in macOS Notifications. Focus and sleep can delay or hide them.${monitorError ? `\n\n**Last check failed:** ${monitorError}` : ""}`}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="Last successful check"
                      text={
                        lastMonitor
                          ? new Date(lastMonitor).toLocaleString()
                          : "Not yet"
                      }
                    />
                    <List.Item.Detail.Metadata.Label
                      title="History"
                      text={STATE_DIRECTORY.replace(/^\/Users\/[^/]+/, "~")}
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ForecastActions
                onRefresh={refresh}
                onToggleMonitoring={toggleMonitoring}
                monitoring={monitoring}
                monitorFirst
              />
            }
          />
        </List.Section>
      )}
      {!error && showOutlook && outlooks.length > 0 && (
        <List.Section title="Codex reset estimates" subtitle="Not quota">
          {outlooks.map((external) => {
            const isScore = external.source === "willcodexquotareset.com";
            const sourceName = isScore ? "Will Codex Reset?" : "Codex Reset";
            const title = isScore ? "48h signal score" : "24h/48h chance";
            const sourceUrl = isScore
              ? "https://www.willcodexquotareset.com/"
              : "https://codex-reset.com/";
            const method = isScore
              ? "The service starts with baseline points and adjusts them using public incidents, team posts, launch signals and a cooldown after recent resets. Softer signals fade with age; repeated hints count once. Its [live JSON](https://www.willcodexquotareset.com/api/forecast) exposes the point breakdown. AI Forecast displays `forecast.score` unchanged, not a locally calculated chance."
              : "The service uses historical reset frequency and may apply caps or display floors for public hints or commitments. AI Forecast displays the API's `probabilities.rounded_24h` and `rounded_48h` unchanged. These experimental display values are not calibrated probabilities. The [published method](https://codex-reset.com/forecast-method) now mainly describes its separate global-or-new-banked outlook, not an exact recipe for these global-only fields; see the [API contract](https://codex-reset.com/developers) and [live JSON](https://codex-reset.com/api/forecast).";
            return (
              <List.Item
                key={external.source}
                id={`outlook-${external.source}`}
                title={title}
                icon={{ source: Icon.Globe, tintColor: Color.SecondaryText }}
                keywords={[
                  "codex",
                  "reset",
                  "bonus",
                  "experimental",
                  "outlook",
                  external.source,
                  sourceName,
                ]}
                accessories={[
                  {
                    text: external.available
                      ? isScore
                        ? `${external.signalScore}/100`
                        : `${external.day}% / ${external.twoDays}%`
                      : "Unavailable",
                    tooltip: isScore
                      ? "Uncalibrated 48-hour signal score, not a reset probability"
                      : "Estimated chance of a global Codex reset in the next 24 or 48 hours, not your scheduled reset",
                  },
                ]}
                detail={
                  <List.Item.Detail
                    markdown={`## ${sourceName}\n\nData: [${external.source}](${sourceUrl})\n\n${isScore ? "**48-hour signal score, not a probability or a statistical confidence level.**" : "**Source-reported estimate of a Codex-wide reset within 24 or 48 hours, not your personal scheduled reset.**"}\n\n### How the source calculates it\n\n${method}\n\n${external.available ? external.note : "No valid reading within the last hour is available from this source, or its retry delay has not elapsed."}\n\nYour **scheduled reset** is the time shown on your quota row in OpenUsage. These sites cannot confirm extra allowance for your account. A new banked grant must be redeemed before it refills usage.\n\n**Never included in your allowance, pace model or alerts.** Shared public signals are not independent evidence, so the two numbers are never averaged. Public readings are cached for at least one minute; no quota or account data is sent.`}
                    metadata={
                      <List.Item.Detail.Metadata>
                        {external.available && external.day !== undefined && (
                          <List.Item.Detail.Metadata.Label
                            title="Global reset · 24h"
                            text={`${external.day}%`}
                          />
                        )}
                        {external.available &&
                          external.twoDays !== undefined && (
                            <List.Item.Detail.Metadata.Label
                              title="Global reset · 48h"
                              text={`${external.twoDays}%`}
                            />
                          )}
                        {external.available &&
                          external.signalScore !== undefined && (
                            <List.Item.Detail.Metadata.Label
                              title="48h signal score"
                              text={`${external.signalScore}/100`}
                            />
                          )}
                        {external.updatedAt && (
                          <List.Item.Detail.Metadata.Label
                            title="Source updated"
                            text={new Date(external.updatedAt).toLocaleString()}
                          />
                        )}
                        <List.Item.Detail.Metadata.Link
                          title="Source"
                          text={external.source}
                          target={sourceUrl}
                        />
                      </List.Item.Detail.Metadata>
                    }
                  />
                }
                actions={
                  <ActionPanel>
                    <Action
                      title="Refresh Forecast"
                      icon={Icon.ArrowClockwise}
                      shortcut={Keyboard.Shortcut.Common.Refresh}
                      onAction={refresh}
                    />
                    <Action
                      title="Open Source Website"
                      icon={Icon.Globe}
                      onAction={() =>
                        perform(
                          () => openOutlook(external.source),
                          "Opened source website in background",
                        )
                      }
                    />
                    <Action
                      title="Extension Preferences"
                      icon={Icon.Gear}
                      onAction={openExtensionPreferences}
                    />
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}
    </List>
  );
}
