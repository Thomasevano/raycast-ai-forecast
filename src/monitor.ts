import {
  environment,
  getPreferenceValues,
  LaunchType,
  LocalStorage,
  showToast,
  Toast,
} from "@raycast/api";
import { readForecast } from "./quota";

export default async function Monitor(): Promise<void> {
  const enabled = await LocalStorage.getItem<boolean>("monitoring");
  if (!enabled) {
    if (environment.launchType === LaunchType.UserInitiated) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Monitoring is paused",
        message: "Open AI Forecast and choose Start Monitoring.",
      });
    }
    return;
  }
  const { openusagePath } = getPreferenceValues<{
    openusagePath?: string;
  }>();
  try {
    const snapshot = await readForecast({
      openusagePath,
      preview: false,
    });
    await LocalStorage.setItem("lastMonitorAt", Date.now());
    await LocalStorage.removeItem("monitorError");
    if (environment.launchType === LaunchType.UserInitiated) {
      await showToast({
        style: Toast.Style.Success,
        title: "Monitoring is on",
        message: snapshot.status,
      });
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Quota monitoring failed.";
    await LocalStorage.setItem("monitorError", message);
    if (environment.launchType === LaunchType.UserInitiated) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not check quotas",
        message,
      });
    }
    throw error;
  }
}
