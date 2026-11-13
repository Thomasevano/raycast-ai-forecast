export type Severity = "normal" | "yellow" | "red" | "unavailable";
export type ProviderKind = "claude" | "codex";
export type WindowKind = "weekly" | "session";

export interface QuotaWindow {
  id: string;
  accountId: string;
  provider: string;
  providerName: string;
  plan: string;
  title: string;
  meter: string;
  reset: string;
  severity: Severity;
  forecast?: { summary: string; detail: string; severity: Severity };
}

export interface Snapshot {
  windows: QuotaWindow[];
  status: string;
  severity: Severity;
}

export interface SourceProvider {
  kind: ProviderKind;
  accountId: string;
  data: Record<string, unknown> | undefined;
}

export interface SourceSnapshot {
  schema: "openusage.limits.v1" | "openusage.limits.v2";
  providers: SourceProvider[];
  partial: boolean;
}

export type Sample = [number, number];
export interface WindowMetadata {
  window: number;
  plan: string;
}
export interface Cycle {
  reset: number;
  rate: number;
  span: number;
  readings: number;
}
export interface WindowState {
  reset: number;
  samples: Sample[];
  pending: { since: number; count: number } | null;
  risk_alert: { at: number; overshoot: number; early: number } | null;
  exhausted: boolean;
  metadata?: WindowMetadata | null;
  cycles?: Cycle[];
  legacy_samples?: Sample[];
}
export interface ForecastState {
  version: 1 | 2 | 3;
  windows: Record<string, WindowState>;
  legacy_bindings?: Partial<Record<ProviderKind, string>>;
}

export type Notifier = (title: string, body: string) => void | Promise<void>;
