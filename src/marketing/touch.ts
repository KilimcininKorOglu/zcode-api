/**
 * Marketing & Touch auto-claimer: polls ZCode's marketing touch API
 * (`GET /api/v1/marketing/touch`) for promotional deliveries (gift tokens,
 * bonuses, campaign perks) and auto-claims them via
 * `POST /api/v1/marketing/touch/action` with `action_type: "confirm"`.
 *
 * The official client (`createMarketingTouchService` in `host/index.js`)
 * queries this endpoint on startup and user identity change. When promotional
 * deliveries are present, user interaction normally triggers the confirmation
 * action. The proxy auto-confirms active campaigns every 30 minutes (or
 * configured interval) so promotional rewards and bonuses are never missed.
 */
import { DEFAULT_MARKETING_CONFIG, type MarketingConfig, type ProxyConfig } from "../config/types.js";
import { loadCredential } from "../auth/store.js";
import type { Credential } from "../auth/types.js";

export interface MarketingTouchDelivery {
  campaign_id?: string;
  campaignId?: string;
  resource_position?: string;
  content?: unknown;
}

export interface MarketingTouchResponse {
  code: number;
  msg?: string;
  data?: {
    server_time?: number;
    language?: string;
    deliveries?: MarketingTouchDelivery[];
  };
}

let seqCounter = 0;
const claimedCampaignIds = new Set<string>();

/** Config accessor: fail open to shipped defaults. */
export function marketingConfigOf(config: ProxyConfig): MarketingConfig {
  return config.marketing ?? DEFAULT_MARKETING_CONFIG;
}

/** Build headers for marketing touch requests. Null without a stored JWT. */
function marketingHeaders(cred: Credential | null, config: ProxyConfig): Record<string, string> | null {
  if (!cred?.jwt) return null;
  return {
    authorization: `Bearer ${cred.jwt}`,
    "x-device-mid": config.identity.deviceMid ?? "",
    "x-client-language": "en-US",
    "x-zcode-app-version": config.identity.appVersion,
    accept: "application/json",
  };
}

/** Fetch active marketing touch deliveries from upstream. */
export async function fetchMarketingTouches(
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
): Promise<MarketingTouchDelivery[]> {
  fetchImpl = testFetchImpl ?? fetchImpl;
  loadCredentialImpl = testLoadCredentialImpl ?? loadCredentialImpl;
  const cred = await loadCredentialImpl().catch(() => null);
  const headers = marketingHeaders(cred ?? null, config);
  if (!headers) return [];

  const origin = marketingConfigOf(config).origin.replace(/\/+$/, "");
  const url = `${origin}/api/v1/marketing/touch?seq=${seqCounter++}`;
  try {
    const resp = await fetchImpl(url, { method: "GET", headers });
    if (!resp.ok) return [];
    const json = (await resp.json()) as MarketingTouchResponse;
    if (json.code !== 0 || !json.data?.deliveries || !Array.isArray(json.data.deliveries)) {
      return [];
    }
    return json.data.deliveries;
  } catch {
    return [];
  }
}

/** Confirm / claim a specific marketing campaign. */
export async function confirmMarketingTouch(
  campaignId: string,
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
): Promise<boolean> {
  fetchImpl = testFetchImpl ?? fetchImpl;
  loadCredentialImpl = testLoadCredentialImpl ?? loadCredentialImpl;
  const cred = await loadCredentialImpl().catch(() => null);
  const headers = marketingHeaders(cred ?? null, config);
  if (!headers) return false;

  const origin = marketingConfigOf(config).origin.replace(/\/+$/, "");
  const url = `${origin}/api/v1/marketing/touch/action`;
  try {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        campaign_id: campaignId,
        action_type: "confirm",
      }),
    });
    if (!resp.ok) return false;
    const json = (await resp.json()) as { code?: number };
    return json.code === 0;
  } catch {
    return false;
  }
}

/**
 * Check active touches and claim any unconfirmed campaigns.
 * Returns the list of campaign IDs successfully claimed on this run.
 */
export async function claimActiveMarketingTouches(
  config: ProxyConfig,
  fetchImpl: typeof fetch = fetch,
  loadCredentialImpl: typeof loadCredential = loadCredential,
): Promise<string[]> {
  fetchImpl = testFetchImpl ?? fetchImpl;
  loadCredentialImpl = testLoadCredentialImpl ?? loadCredentialImpl;
  const deliveries = await fetchMarketingTouches(config, fetchImpl, loadCredentialImpl);
  const newlyClaimed: string[] = [];

  for (const delivery of deliveries) {
    const campaignId = (delivery.campaign_id ?? delivery.campaignId)?.trim();
    if (!campaignId || claimedCampaignIds.has(campaignId)) continue;

    const ok = await confirmMarketingTouch(campaignId, config, fetchImpl, loadCredentialImpl);
    if (ok) {
      claimedCampaignIds.add(campaignId);
      newlyClaimed.push(campaignId);
      console.log(`[marketing] auto-claimed campaign: ${campaignId}`);
    }
  }

  if (newlyClaimed.length === 0) {
    if (deliveries.length > 0) {
      console.log(`[marketing] checked promotional touches (${deliveries.length} active campaign(s), already claimed)`);
    } else {
      console.log("[marketing] checked promotional touches (no active gifts/promotions)");
    }
  }

  return newlyClaimed;
}

export interface MarketingPoller {
  stop(): void;
  tick(): Promise<string[]>;
}

export interface MarketingPollerDeps {
  fetchImpl?: typeof fetch;
  loadCredentialImpl?: typeof loadCredential;
}

/** Start the background marketing campaign auto-claim scheduler. */
export function startMarketingPoller(config: ProxyConfig, deps: MarketingPollerDeps = {}): MarketingPoller {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const intervalMs = marketingConfigOf(config).intervalSec * 1000;

  const poller: MarketingPoller = {
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    async tick(): Promise<string[]> {
      if (stopped) return [];
      return claimActiveMarketingTouches(config, deps.fetchImpl, deps.loadCredentialImpl);
    },
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void poller.tick().finally(scheduleNext);
    }, intervalMs);
  };

  void poller.tick().finally(scheduleNext);
  return poller;
}

/** Set of currently claimed campaign IDs (for inspection in tests). */
export function getClaimedCampaignIds(): Set<string> {
  return new Set(claimedCampaignIds);
}

/** Restore pristine state in tests. */
export function __resetMarketingStateForTests(): void {
  claimedCampaignIds.clear();
  seqCounter = 0;
  testFetchImpl = null;
  testLoadCredentialImpl = null;
}

let testFetchImpl: typeof fetch | null = null;
let testLoadCredentialImpl: typeof loadCredential | null = null;

export function __setMarketingDepsForTests(deps: {
  fetchImpl?: typeof fetch;
  loadCredentialImpl?: typeof loadCredential;
}): void {
  testFetchImpl = deps.fetchImpl ?? null;
  testLoadCredentialImpl = deps.loadCredentialImpl ?? null;
}
