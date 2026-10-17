/**
 * Daily active telemetry heartbeat — mirrors the official ZCode client's
 * `createTelemetryCore` (`chunk-ZCWQ2IP2.js`).
 *
 * The official client emits two vital lifecycle telemetry events to
 * `https://zcode.z.ai/api/v1/event/report`:
 *   1. `app_launch`: fired on startup.
 *   2. `app_daily_active`: fired once per calendar day (scoped to client timezone).
 *
 * Upstream gates coding-plan reset rights and promotional opportunities behind
 * this active desktop telemetry: accounts that do not report daily activity are
 * flagged as inactive/headless and rejected with biz code 3301
 * ("coding plan reset grant not allowed").
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";
import { loadCredential } from "../auth/store.js";
import type { Credential } from "../auth/types.js";
import {
  buildIdentityHeaders,
  normalizeOsCategory,
  normalizePrintableHeaderValue,
  resolveClientLanguage,
  resolveClientTimezone,
} from "../proxy/identity.js";

const TELEMETRY_ORIGIN = "https://zcode.z.ai";
const REPORT_PATH = "/api/v1/event/report";

export type TelemetryLifecycleEvent = "app_launch" | "app_daily_active";

export interface TelemetryPayload {
  event_id: string;
  client_timezone: string;
  client_language: string;
  element_name: TelemetryLifecycleEvent;
  event_region: string;
  event_type: string;
  event_text: string;
  event_extra_detail: Record<string, unknown>;
  user_id: string;
  screen_resolution: string;
  app_version: string;
  device_os_category: string;
  device_os_version: string;
  device_mid: string;
  mac_id: string;
  marketing_params: string;
}

/** Compute today's date formatted as YYYY-MM-DD in the target timezone. */
export function getCalendarDateInTimezone(timezone: string, date: Date = new Date()): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Send a single lifecycle event (`app_launch` or `app_daily_active`) to
 * `https://zcode.z.ai/api/v1/event/report`. Fail-open: returns false on error.
 */
export async function sendTelemetryEvent(
  elementName: TelemetryLifecycleEvent,
  cred: Credential | null,
  identity: ProxyIdentity,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!cred?.jwt) return false;

  const clientTimezone = resolveClientTimezone() ?? "Europe/Istanbul";
  const clientLanguage = resolveClientLanguage() ?? "en-US";
  const platform = (process.env.ZCODE_IDENTITY_PLATFORM ?? process.platform) as NodeJS.Platform;
  const osVersion = normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_RELEASE) ?? os.release();

  const payload: TelemetryPayload = {
    event_id: randomUUID(),
    client_timezone: clientTimezone,
    client_language: clientLanguage,
    element_name: elementName,
    event_region: "app",
    event_type: "view",
    event_text: "",
    event_extra_detail: {},
    user_id: cred.userId ?? "",
    screen_resolution: "1920x1080",
    app_version: identity.appVersion,
    device_os_category: normalizeOsCategory(platform),
    device_os_version: osVersion,
    device_mid: identity.deviceMid ?? "",
    mac_id: "",
    marketing_params: "{}",
  };

  const headers = {
    "content-type": "application/json",
    ...buildIdentityHeaders(identity),
    authorization: `Bearer ${cred.jwt}`,
  };

  try {
    const resp = await fetchImpl(`${TELEMETRY_ORIGIN}${REPORT_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!resp.ok) return false;
    const body = (await resp.json().catch(() => null)) as { code?: number } | null;
    return body?.code === 0;
  } catch {
    return false;
  }
}

export const TELEMETRY_HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes, mirrors ZCode 3.15.1 dailyActiveHeartbeatIntervalMs (9e5)

let lastReportedDailyActiveDate: string | null = null;
let lastReportedLaunchDate: string | null = null;

/** Reset state for unit tests. */
export function resetTelemetryStateForTest(): void {
  lastReportedDailyActiveDate = null;
  lastReportedLaunchDate = null;
}

/**
 * Ensure `app_launch` (on startup or each calendar day) and `app_daily_active`
 * (for today) have been submitted to ZCode's telemetry server.
 */
export async function ensureDailyActiveReported(
  cred: Credential | null,
  identity: ProxyIdentity,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!cred?.jwt) return false;

  const timezone = resolveClientTimezone() ?? "Europe/Istanbul";
  const today = getCalendarDateInTimezone(timezone);

  if (lastReportedLaunchDate !== today) {
    const okLaunch = await sendTelemetryEvent("app_launch", cred, identity, fetchImpl);
    if (okLaunch) {
      lastReportedLaunchDate = today;
    }
  }

  if (lastReportedDailyActiveDate === today) {
    return true;
  }

  const okDaily = await sendTelemetryEvent("app_daily_active", cred, identity, fetchImpl);
  if (okDaily) {
    lastReportedDailyActiveDate = today;
    console.log(`[telemetry] reported daily active status for ${today}`);
    return true;
  }

  return false;
}

/**
 * Start background heartbeat that keeps daily active status refreshed across
 * calendar day rollovers. Runs every 15 minutes matching official desktop client.
 */
export function startTelemetryHeartbeat(
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
): { stop: () => void; tick: () => Promise<void> } {
  let timer: Timer | null = null;
  let running = true;

  const tick = async (): Promise<void> => {
    try {
      const cred = await loadCredentialImpl().catch(() => null);
      if (!cred?.jwt) return;
      await ensureDailyActiveReported(cred, config.identity, fetchImpl);
    } catch {
      // Ignore background telemetry errors (fail-open)
    }
  };

  // Run initial heartbeat immediately
  tick().catch(() => {});

  // Check every 15 minutes for date rollovers and keep-alive
  timer = setInterval(() => {
    if (!running) return;
    tick().catch(() => {});
  }, TELEMETRY_HEARTBEAT_INTERVAL_MS);

  return {
    tick,
    stop() {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
