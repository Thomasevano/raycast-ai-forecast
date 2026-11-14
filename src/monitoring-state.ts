export interface MonitorHealth {
  enabled?: boolean;
  last?: number;
  error?: string;
  checkedAt: number;
}

export function monitoringEnabled(
  value: string | number | boolean | undefined,
): boolean {
  if (value === undefined || value === false || value === 0) return false;
  if (value === true || value === 1) return true;
  throw new Error("Monitoring setting has an invalid value.");
}

function overdue(
  health: Omit<MonitorHealth, "checkedAt">,
  checkedAt: number,
): boolean {
  if (!health.enabled || health.error || !health.last) return false;
  return checkedAt - health.last > 600_000;
}

export function updateMonitorHealth(
  previous: MonitorHealth,
  next: Omit<MonitorHealth, "checkedAt">,
  checkedAt: number,
): MonitorHealth {
  if (
    previous.enabled === next.enabled &&
    previous.last === next.last &&
    previous.error === next.error &&
    overdue(previous, previous.checkedAt) === overdue(next, checkedAt)
  )
    return previous;
  return { ...next, checkedAt };
}
