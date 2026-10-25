/**
 * Main proxy handler — routes requests, injects auth, forwards, and streams responses.
 *
 * **v2.6 upstream reality (post-PR #34)**: BOTH plan tiers post an
 * Anthropic-format upstream — coding-plan mirrors the real ZCode client
 * (api.z.ai/api/anthropic → ultra via endpoint routing); start-plan posts to
 * zcode.z.ai's Anthropic gateway with the plan JWT. Consequently:
 * - OpenAI clients are translated OpenAI→Anthropic on the way up and
 *   Anthropic→OpenAI on the way down ("translation" mode).
 * - Anthropic clients speak the upstream's native format — requests are
 *   forwarded with body transforms only ("passthrough" mode,
 *   `decompress: false`).
 *
 * @see .omo/plans/zcode-proxy.md Task 6
 */
import type { Format } from "../translator/types.js";
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { getProvider } from "../provider/providers.js";
import { buildUpstreamHeaderPairs, buildUpstreamRequest, type UpstreamHeaderPair } from "./upstream.js";
import { getDefaultEndpointRouting, type EndpointRoutingService } from "./endpoint-routing.js";
import { getDefaultClientSigning, sendWithClientSigning, type ClientSigningManager } from "./client-signing.js";
import {
  applyHighspeedCardHeaders,
  getDefaultHighspeedManager,
  highspeedAuthFrom,
  isHighspeedCardRejection,
  rewriteBodyModel,
  type HighspeedAuth,
  type HighspeedCard,
  type HighspeedManager,
} from "../highspeed/manager.js";
import { credentialString } from "../auth/types.js";
import { sendOrderedUpstreamRequest, orderedAdvertisedCodings } from "./ordered-transport.js";
import { transformRequestBody } from "./body-transformer.js";
import { isCaptchaChallenged, retryOnCaptchaChallenge, resolveCaptchaAcquireBudgetMs, acquireCaptchaWithRetry, type CaptchaModuleLike } from "./captcha-retry.js";
import { activePlan, planPriorityOf, retryOnPlanExhausted, sniffStartPlanRejection, shouldFallbackPlan, type PlanTier } from "../plan/auto.js";
import { maybeUsePlanResetAndRetry } from "../plan/reset.js";
import { clientTraceFields, type ClientSessionResult } from "./client-session.js";
import { resolveSessionContext } from "./session-context.js";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

// captcha.ts is loaded lazily inside the `startPlan` branch (only path that
// touches it). The solver itself (captcha-happy.ts) is dynamically imported
// by captcha-solver.ts, so non-start-plan processes never pay its startup
// cost. Desktop Bun keeps the same code path; the dynamic import resolves
// synchronously enough on Bun's warm cache.
type CaptchaModule = CaptchaModuleLike;
let captchaModule: CaptchaModule | null = null;
async function loadCaptcha(): Promise<CaptchaModule> {
  if (!captchaModule) captchaModule = await import("./captcha.js");
  return captchaModule;
}
import { translateRequestOpenAIToAnthropic, translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import { translateRequestAnthropicToOpenAI, translateResponseOpenAIToAnthropic } from "../translator/anthropic-to-openai.js";
import { anthropicSseToOpenaiSse, openaiSseToAnthropicSse } from "../translator/sse-translator.js";
import type { OpenAIChatRequest, OpenAIChatResponse, AnthropicMessagesRequest, AnthropicMessagesResponse } from "../translator/types.js";
import { dumpPhase, dumpHeaders, dumpBody, dumpEnabled } from "./dump.js";
import { clientAcceptsCoding, inflateFormatFor, inflateStreamForCodings, inflateWithCap } from "./inflate.js";
import { probeFetchDecompressBehavior } from "./decompress-probe.js";
import { collectAnthropicMessage } from "./sse-collector.js";
import { appendErrorLog } from "./error-log.js";
import { StreamMetrics } from "./stream-metrics.js";
import { buildAnthropicMetadataUserId, SUBAGENT_PREFIX } from "./trace-headers.js";
import { hasCustomSystemPrompt } from "./system-prompt.js";

/** Options for the proxy handler. */
export interface ProxyHandlerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override the global fetch (for testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * When true, emit additional per-request diagnostic lines: upstream URL,
   * redacted request headers, body preview, upstream response status and
   * selected response headers. Activated by `zcode-proxy serve debug`.
   */
  debug?: boolean;
  /** Override the process-wide endpoint routing service (for testing). `null` disables. */
  endpointRouting?: EndpointRoutingService | null;
  /** Override the process-wide client signing manager (for testing). `null` disables. */
  clientSigning?: ClientSigningManager | null;
  /** Override the process-wide highspeed card manager (for testing). `null` disables. */
  highspeed?: HighspeedManager | null;
  /** Override the lazily-imported captcha module (for testing). */
  captcha?: CaptchaModule;
}

/**
 * Forward a client request to the upstream provider with injected auth.
 *
 * Upstream fetch options differ by mode:
 * - **Passthrough** (OpenAI client): `{ decompress: false }` — compressed
 *   response bodies (gzip/deflate/br) pass through untouched; raw bytes and the
 *   Content-Encoding header are forwarded as-is, letting the client decompress.
 * - **Translation** (Anthropic client): no options — Bun decompresses so the proxy
 *   can read the body and translate OpenAI→Anthropic (then re-gzip if the client
 *   accepts).
 *
 * No upstream timeout is applied — matches ZCode desktop client behaviour
 * (the bundle has no automatic timer on LLM calls, only user-initiated abort).
 * Connection-level errors (ECONNREFUSED, DNS failure) still surface as 502.
 */
export async function proxyRequest(
  clientReq: Request,
  format: Format,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  const { config, auth } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hasCustomFetchImpl = opts.fetchImpl !== undefined;
  const debug = opts.debug === true;
  const started = Date.now();
  const reqId = nextReqId();

  let body: string | undefined;
  try {
    body = await readBody(clientReq);
  } catch (err) {
    if (err instanceof InflatedBodyTooLargeError) {
      return errorResponse(413, "request_too_large", err.message);
    }
    return errorResponse(400, "invalid_request_error", (err as Error).message);
  }

  const meta = peekBody(body);
  Object.assign(meta, clientTraceFields(clientReq));

  if (dumpEnabled()) {
    dumpPhase(reqId, "client_in", {
      method: clientReq.method,
      url: clientReq.url,
      headers: dumpHeaders(clientReq.headers),
      body: dumpBody(body),
    });
  }

  const staticProvider = getProvider(config.provider);
  const provider = {
    ...staticProvider,
    anthropicBaseURL: config.providers[config.provider].anthropicBase,
    openaiBaseURL: config.providers[config.provider].openaiBase,
  };

  let cred;
  try {
    cred = await auth.getCredential();
  } catch (err) {
    if (debug) debugError(reqId, "credential_unavailable", (err as Error).message);
    printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
    return errorResponse(503, "credential_unavailable", (err as Error).message);
  }

  // v2.6: both plans use the Anthropic upstream. coding-plan mirrors the real
  // ZCode client (api.z.ai/api/anthropic → ultra via endpoint routing);
  // start-plan's old OpenAI gateway (/api/v1/zcode-plan/chat/completions) was
  // retired server-side (404 as of 2026-08-28) — the live desktop client now
  // posts Anthropic messages to /api/v1/zcode-plan/anthropic/v1/messages with
  // the start-plan JWT, so we do the same (no OpenAI translation either way).
  // The hybrid plan auto-switch resolves ONCE per request: the background
  // watcher may flip the effective plan between requests, never mid-request.
  const isCountTokens = clientReq.url.includes("/count_tokens");
  if (isCountTokens) meta.countTokens = true;
  let plan: PlanTier = isCountTokens && cred.apiKey ? "coding-plan" : activePlan(config);
  let startPlan = plan === "start-plan";
  meta.plan = plan;
  const translateAnthropicToOpenAI = false;
  const translateOpenAIToAnthropic = format === "openai";
  const upstreamFormat: Format = "anthropic";

  let upstreamBody = body;
  if (translateOpenAIToAnthropic) {
    const translated = translateOpenAIBody(body);
    if (translated instanceof Response) return translated;
    upstreamBody = translated;
    if (debug) debugLine(reqId, `translated OpenAI→Anthropic (bytes=${upstreamBody?.length ?? 0})`);
  } else if (translateAnthropicToOpenAI) {
    const translated = translateAnthropicBody(body);
    if (translated instanceof Response) return translated;
    upstreamBody = translated;
    if (debug) debugLine(reqId, `translated Anthropic→OpenAI (bytes=${upstreamBody?.length ?? 0})`);
  }

  // Batch requests ride upstream as streams: the gateway kills requests whose
  // time-to-first-byte sits silent past ~180s — unreachable while streaming,
  // routine for long non-streaming generations (live 2026-10-05: connection
  // deaths at exactly 2m59s with no status line at all). Streaming answers
  // immediately; the SSE is reassembled into the single JSON the client
  // expects (see the `!meta.stream` SSE branch below). Injected into
  // `upstreamBody` so the plan-fallback and captcha rebuilds — which
  // re-transform from it — keep the flag.
  if (!isCountTokens && config.batchAsStream !== false && !meta.stream && upstreamBody !== undefined) {
    upstreamBody = withStreamEnabled(upstreamBody);
    if (debug) debugLine(reqId, "batch request sent upstream as stream");
  }

  // Session affinity is calculated on the translated anthropic side: upstream requests are always
  // Anthropic shape, so OpenAI client and Anthropic client in the same conversation get isomorphic
  // canonical identity (hash lineage / task identity aligned with upstream conversation, not client dialect).
  let clientSession = resolveSessionContext({ clientReq, body: upstreamBody, traceBody: body, upstreamFormat, model: meta.model, config });
  if (debug && clientSession) {
    const shortSession = clientSession.sessionId ? clientSession.sessionId.slice(0, 10) : "-";
    debugLine(reqId, `clientIdentity source=${clientSession.source} action=${clientSession.action} confidence=${clientSession.confidence.toFixed(2)} session=${shortSession}`);
  }

  // start-plan + client system prompt: body-transformer emits the official
  // customSystemPrompt shape (2 system blocks, subagent shape). The gateway
  // cross-checks x-zcode-session-type against the system shape; main + custom
  // = 405/3012 "unusual activity" (opencode-502 root cause, live-verified
  // 2026-10-23; subagent + custom 200). Custom requests therefore ride the
  // subagent session identity — see applyCustomSystemSession.
  clientSession = applyCustomSystemSession(clientSession, startPlan, upstreamBody, debug, reqId);

  // Bundle `E2e` fires for EVERY anthropic-kind request (both plans) — the
  // injected user_id is the device/session blob, never the account uuid.
  const metadataUserId = buildAnthropicMetadataUserId(config.identity.deviceMid, clientSession?.sessionId);
  let transformedBody = transformRequestBody(upstreamBody, { format: upstreamFormat, metadataUserId, startPlan, provider: config.provider });
  if (debug && transformedBody !== upstreamBody) {
    debugLine(reqId, `body transformed (upstreamFormat=${upstreamFormat}, startPlan=${startPlan}, bytes=${transformedBody?.length ?? 0})`);
  }

  // ── HighSpeed acceleration card (3.15.1 mirror, enabled by default) ──
  // coding-plan + eligible model: lazily trigger draw (affinity task_id); within the card
  // window, rewrite model to card's model and replace auth suite (buildHighspeedTurnExecution isomorphic).
  // Carded requests are not signed (official static rule: highspeed mode never signs).
  const highspeedManager = opts.highspeed !== undefined ? opts.highspeed : getDefaultHighspeedManager(config);
  let highspeedCard: HighspeedCard | undefined;
  let highspeedAuth: HighspeedAuth | undefined = undefined;
  let highspeedOrigBody: string | undefined;
  let highspeedOrigPairs: UpstreamHeaderPair[] | undefined;
  if (!isCountTokens && highspeedManager && !startPlan && highspeedManager.isEligibleModel(meta.model) && transformedBody) {
    const auth = highspeedAuthFrom(cred);
    if (auth) {
      highspeedAuth = auth;
      highspeedManager.onRequest(meta.model, clientSession?.upstreamSessionId, auth);
      const card = highspeedManager.activeCard();
      if (card) {
        highspeedOrigBody = transformedBody;
        transformedBody = rewriteBodyModel(transformedBody, card.model);
        highspeedCard = card;
        if (debug) debugLine(reqId, `highspeed card applied (${card.cardId.slice(0, 12)}… model=${card.model}, window ${Math.round((card.expiresAt - Date.now()) / 1000)}s)`);
      }
    }
  }

  let captchaHeaders: Record<string, string> | undefined;
  // In-flight is activity: an SSE still producing
  // is not idle — refresh the captcha pool's and highspeed draw loop's idle
  // windows when the request completes, so a long stream cannot decay the
  // pool or self-extinguish the loop (the next tool-loop turn would land on
  // a falsely idle pool). Captcha stays lazily imported (coding-plan never
  // loads it); highspeed is only noted for requests that entered onRequest —
  // noting ineligible traffic would spin the draw loop for traffic that can
  // never mount a card.
  const hsNoteEligible = highspeedAuth !== undefined;
  const noteInFlightEnded = (): void => {
    if (startPlan) void (opts.captcha ? Promise.resolve(opts.captcha) : loadCaptcha()).then((m) => m.noteDemand?.()).catch(() => {});
    if (hsNoteEligible) highspeedManager?.noteActivity();
  };
  if (startPlan) {
    // Captcha headers are load-bearing on the start plane (live 2026-10-23):
    // a captcha-less dispatch is a shape the real
    // client never produces and the ESA edge answers it with intermittent
    // empty-body 502s (no origin request-id; the 403 challenge retry below
    // does not recognize that failure). Acquisition failures therefore retry
    // within a bounded budget and then answer an honest 503 — never
    // fail-open without headers. A null token means the server explicitly
    // disabled captcha, where no headers IS the correct shape.
    try {
      captchaHeaders = await acquireCaptchaWithRetry(async () => {
        const captcha = opts.captcha ?? (await loadCaptcha());
        const token = await captcha.getCaptchaToken(config.identity.appVersion, config.identity);
        return token ? { [captcha.RETRY_HEADERS.PARAM]: token.verifyParam, [captcha.RETRY_HEADERS.REGION]: token.region } : undefined;
      }, {
        budgetMs: resolveCaptchaAcquireBudgetMs(process.env.CAPTCHA_ACQUIRE_BUDGET_MS),
        signal: clientReq.signal,
        onRetry: debug ? (err) => debugError(reqId, "captcha_acquire_retry", `${err.message}; retrying`) : undefined,
      });
    } catch (err) {
      if (debug) debugError(reqId, "captcha_solver_failed", (err as Error).message);
      printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
      return errorResponse(503, "captcha_solver_failed", `Captcha acquisition failed: ${(err as Error).message}. The start-plan edge rejects captcha-less requests — retry shortly.`);
    }
  }

  const useOrderedTransport = shouldUseOrderedTransport(clientSession, hasCustomFetchImpl);
  let upstreamHeaderPairs = buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, config.identity, plan, captchaHeaders, clientSession);
  if (highspeedCard && highspeedAuth) {
    highspeedOrigPairs = upstreamHeaderPairs;
    upstreamHeaderPairs = applyHighspeedCardHeaders(upstreamHeaderPairs, highspeedCard, highspeedAuth);
  }
  let upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, plan, captchaHeaders, clientSession);
  if (highspeedCard && highspeedAuth) {
    // dispatch reuses the pre-built Request whenever the signer returns the
    // pairs unchanged (unsigned path) — rebuild it from the swapped pairs so
    // the card headers actually reach the wire (buildUpstreamRequest derives
    // its own header set internally).
    upstreamReq = new Request(upstreamReq.url, {
      method: upstreamReq.method,
      headers: Object.fromEntries(upstreamHeaderPairs),
      body: transformedBody ?? undefined,
    });
  }

  const routing = opts.endpointRouting !== undefined ? opts.endpointRouting : getDefaultEndpointRouting(config);
  let signer = opts.clientSigning !== undefined ? opts.clientSigning : getDefaultClientSigning(config);
  // Official 3.15.1 static rule: inference requests in highspeed mode are never signed (`TUs` returns false).
  if (highspeedCard) signer = null;
  const translateMode = translateOpenAIToAnthropic || translateAnthropicToOpenAI;
  // When the ordered transport must READ the upstream body (translate mode), it
  // has to inflate whatever coding the upstream picks — cap the advertised
  // accept-encoding (a passthrough of the inbound client's list, which browsers
  // set to `gzip, deflate, br, zstd`) to what the transport can decompress.
  // The ultra CDN serves SSE brotli-compressed when `br` is advertised, and a
  // coding the transport cannot inflate would starve the SSE translator
  // (observed 2026-09-18 as 0-byte streams → client timeouts). Pure-passthrough
  // requests keep the client's list verbatim — the client decodes those itself.
  if (useOrderedTransport && translateMode) {
    upstreamHeaderPairs = capOrderedAcceptEncoding(upstreamHeaderPairs);
  }
  const dispatch = async (req: Request, pairs: UpstreamHeaderPair[]): Promise<Response> => {
    let sendUrl = req.url;
    let routingHeaderPairs: UpstreamHeaderPair[] | undefined;
    if (routing) {
      const routed = await routing.resolve(req.url, credentialString(cred), cred.jwt);
      if (routed.routed) {
        sendUrl = routed.url;
        routingHeaderPairs = routed.headers ? (Object.entries(routed.headers) as UpstreamHeaderPair[]) : undefined;
        if (debug) debugLine(reqId, `endpoint routing: ${req.url} -> ${routed.url}`);
      }
    }
    // Signing decisions (exempt-path, handshake origin, bypass keying) run
    // against the PRE-routing provider URL — the client's signer wraps the
    // routing transport, so its checks see the original URL too. A gateway
    // 502/504 is a complete LB answer, not a connect error; retry it once
    // here so EVERY dispatch (initial, plan fallback, captcha retry) gets
    // the same second chance.
    return retryOnGatewayError(
      () =>
        sendWithClientSigning(signer, {
          url: req.url,
          headerPairs: pairs,
          credential: credentialString(cred),
          oauthAccessToken: cred.oauthAccessToken,
          provider: cred.provider,
          appVersion: config.identity.appVersion,
          debug: debug ? (message) => debugLine(reqId, message) : undefined,
          send: (finalPairs) => {
            // 3.16.2 X-ZCode-Authorization: the client appends it inside its
            // routing wrapper, which sits INSIDE the signing wrapper — so on the
            // wire it lands after the signature block, as the very last header.
            const outboundPairs = routingHeaderPairs ? [...finalPairs, ...routingHeaderPairs] : finalPairs;
            if (dumpEnabled()) {
              // The pre-built `upstream_out` line shows the pre-routing URL and
              // pre-signing header set; this line captures what actually went on
              // the wire (routed URL + signed pairs) — the two diverge silently
              // otherwise and misled a 2026-09-18 debugging session.
              dumpPhase(reqId, "wire_out", {
                url: sendUrl,
                signed: outboundPairs.some(([k]) => k.toLowerCase() === "x-client-sig"),
                headers: dumpHeaders(new Headers(Object.fromEntries(outboundPairs))),
              });
            }
            // Always a FRESH Request: a reused one has its body stream marked
            // used after the first fetch, which would break the gateway retry.
            const sendReq = new Request(sendUrl, {
              method: req.method,
              headers: Object.fromEntries(outboundPairs),
              body: transformedBody ?? undefined,
            });
            return sendUpstreamRequest(sendReq, outboundPairs, transformedBody, translateMode, useOrderedTransport, fetchImpl, clientReq.signal, hasCustomFetchImpl);
          },
        }),
      {
        isAborted: () => clientReq.signal.aborted,
        onRetry: (status, resp) => {
          console.log(`${reqId} upstream gateway ${status}, retrying once`);
          appendErrorLog({ kind: "upstream_gateway_retry", reqId, status, upstreamRequestId: upstreamRequestId(resp), ...clientTraceFields(clientReq) });
        },
        onAbort: (status, resp) => {
          console.log(`${reqId} upstream gateway ${status}, client already gone, not retrying`);
          appendErrorLog({ kind: "upstream_gateway_skip_client_gone", reqId, status, upstreamRequestId: upstreamRequestId(resp), ...clientTraceFields(clientReq) });
        },
      },
    );
  };

  if (debug) {
    debugLine(reqId, `→ POST ${upstreamReq.url}`);
    debugLine(reqId, `  ${formatHeaderPairs(upstreamReq.headers)}`);
    if (transformedBody) debugLine(reqId, `  body preview: ${previewBody(transformedBody)}`);
  }

  if (dumpEnabled()) {
    dumpPhase(reqId, "upstream_out", {
      method: upstreamReq.method,
      url: upstreamReq.url,
      headers: dumpHeaders(upstreamReq.headers),
      body: dumpBody(transformedBody),
      upstreamFormat,
      translateMode: translateOpenAIToAnthropic || translateAnthropicToOpenAI,
      useOrderedTransport,
      startPlan,
    });
  }

  let upstreamResp: Response;
  try {
    // Transient connect failures (DNS blip, TLS reset, Bun "Unable to
    // connect") happen a few times a day against the gateway. Retry the
    // CONNECT twice with a short backoff before surfacing a 502 — the
    // request never reached upstream, so resending is side-effect-free.
    // Guard rails: skip retry when the client already aborted or the ordered
    // transport flagged the failure postWrite; re-dispatch a FRESH Request
    // each attempt — a reused Request has its body stream marked used after
    // the first fetch (start-plan hits the plain pass-through path where
    // dispatch does NOT rebuild the Request).
    let dispatchAttempt = 0;
    upstreamResp = await dispatchWithConnectRetry(
      () => {
        dispatchAttempt += 1;
        const currentReq = dispatchAttempt === 1
          ? upstreamReq
          : highspeedCard
            // buildUpstreamRequest derives its own (uncarded) header set; a
            // carded rebuild must come from the swapped pairs — same reuse
            // hazard as the attempt-1 rebuild above
            ? new Request(upstreamReq.url, {
              method: upstreamReq.method,
              headers: Object.fromEntries(upstreamHeaderPairs),
              body: transformedBody ?? undefined,
            })
            : buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, plan, captchaHeaders, clientSession);
        return dispatch(currentReq, upstreamHeaderPairs);
      },
      {
        isAborted: () => clientReq.signal.aborted,
        onRetry: (attempt, err) => {
          if (debug) debugError(reqId, "upstream_connect_retry", `attempt ${attempt}/${MAX_CONNECT_ATTEMPTS - 1} failed (${err.message}), retrying in ${500 * attempt}ms`);
          console.log(`${reqId} upstream connect failed (${(err as Error).message || "no detail"}), retry ${attempt + 1}/${MAX_CONNECT_ATTEMPTS} in ${500 * attempt}ms`);
          appendErrorLog({ kind: "upstream_connect_retry", reqId, attempt, error: err.message, ...clientTraceFields(clientReq) });
        },
      },
    );
  } catch (err) {
    if (debug) debugError(reqId, "upstream_unreachable", (err as Error).message);
    // The ladder logs its own retry lines for ordinary connect failures; the
    // two failures it rethrows WITHOUT any line would otherwise surface as a
    // bare 502 row that cannot be told apart from a retried one: a postWrite
    // transport death (the request was fully on the wire, so by design it is
    // never resent) and a client that hung up before the first connect.
    if ((err as { postWrite?: boolean }).postWrite) {
      console.log(`${reqId} upstream connection lost after the request was written, not retried`);
      appendErrorLog({ kind: "upstream_postwrite_failure", reqId, error: (err as Error).message, ...clientTraceFields(clientReq) });
    } else if ((err as Error).message === CLIENT_ABORTED_BEFORE_CONNECT) {
      console.log(`${reqId} client gone before upstream connect, not retrying`);
      appendErrorLog({ kind: "client_gone_before_connect", reqId, ...clientTraceFields(clientReq) });
    }
    printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
    return errorResponse(502, "upstream_unreachable", unreachableMessage(err));
  }
  const headersAt = Date.now();
  meta.upstreamRequestId = upstreamRequestId(upstreamResp);

  if (debug) {
    debugLine(reqId, `← ${upstreamResp.status} ${upstreamResp.statusText}`);
    debugLine(reqId, `  ${formatResponseHeaders(upstreamResp.headers)}`);
  }

  if (dumpEnabled()) {
    dumpPhase(reqId, "upstream_in", {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: dumpHeaders(upstreamResp.headers),
      isSSE: upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false,
      ttfbMs: headersAt - started,
    });
  }

  // Hybrid plan fallback (only while planAutoSwitch is on — the fallback is
  // part of the auto-switch; with it off, plan selection is entirely the
  // operator's config and failures pass through untouched): the serving
  // plan's gateway rejected the request (rejected auth / exhausted quota).
  // Retry the SAME request once on the NEXT plan in config.planPriority and
  // cool the rejected plan down until the watcher sees it usable again.
  // Body + headers rebuild with the target plan — the body transform
  // (start-plan system) and the auth builder (JWT vs API key) are both
  // plan-aware. Rejection covers error statuses AND, on start-plan, HTTP 200
  // with a JSON error envelope — that gateway exhausts a plan that way too
  // (observed live 2026-10-06: 200 + {"code":1005,"msg":"exceed quota
  // limit"}).
  // Rebuild the upstream request for one plan tier, shared by the auto-reset
  // retry and the plan fallback below (same body transform + header build).
  const rebuildForPlan = async (target: PlanTier): Promise<Response> => {
    transformedBody = transformRequestBody(upstreamBody, { format: upstreamFormat, metadataUserId, startPlan: target === "start-plan", provider: config.provider });
    upstreamHeaderPairs = buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, config.identity, target, undefined, clientSession);
    if (useOrderedTransport && translateMode) {
      upstreamHeaderPairs = capOrderedAcceptEncoding(upstreamHeaderPairs);
    }
    upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, target, undefined, clientSession);
    return dispatch(upstreamReq, upstreamHeaderPairs);
  };

  // highspeed selectionFallback (official semantics): when a carded request receives 401 / biz 3402
  // (card expired/rejected), drop the card, and re-send once with original model + regular coding-plan auth (restoring signer).
  if (highspeedCard && highspeedManager && highspeedOrigBody !== undefined && highspeedOrigPairs !== undefined
    && (await isHighspeedCardRejection(upstreamResp))) {
    console.log(`${reqId} highspeed card rejected upstream — falling back to session model`);
    highspeedManager.dropCard("upstream_rejected");
    transformedBody = highspeedOrigBody;
    // restore + re-cap: highspeedOrigPairs was captured BEFORE the ordered-
    // transport accept-encoding cap, which only ran against the carded pairs
    // (same re-cap the captcha retry path performs after rebuilding pairs)
    upstreamHeaderPairs = useOrderedTransport && translateMode
      ? capOrderedAcceptEncoding(highspeedOrigPairs)
      : highspeedOrigPairs;
    signer = opts.clientSigning !== undefined ? opts.clientSigning : getDefaultClientSigning(config);
    const fallbackReq = buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, plan, captchaHeaders, clientSession);
    try {
      upstreamResp = await dispatch(fallbackReq, upstreamHeaderPairs);
    } catch (err) {
      if (debug) debugError(reqId, "upstream_unreachable", (err as Error).message);
      printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
      return errorResponse(502, "upstream_unreachable", (err as Error).message);
    }
    if (debug) debugLine(reqId, `highspeed fallback dispatched (status=${upstreamResp.status})`);
  }

  // Auto reset-right use: a coding-plan 429 with a held FIVE_HOUR right spends
  // it and retries the SAME request on the reopened window — independent of
  // planAutoSwitch (spending a granted right is not a plan switch). A
  // transient rate-limit body blocks the spend (that 429 is load, not
  // exhaustion). On failure or no right, control flows to the fallback below.
  if (plan === "coding-plan" && upstreamResp.status === 429) {
    const rejectionBody = (await upstreamResp.clone().text().catch(() => null))?.slice(0, 65536) ?? null;
    const reset = await maybeUsePlanResetAndRetry({ plan, config, rejectionBody, rebuildAndDispatch: rebuildForPlan });
    if (reset.handled && reset.resp) upstreamResp = reset.resp;
  }

  if (config.planAutoSwitch === true) {
    let planRejected = shouldFallbackPlan(upstreamResp.status, plan);
    if (!planRejected && plan === "start-plan" && upstreamResp.status === 200) {
      const sniff = await sniffStartPlanRejection(upstreamResp);
      planRejected = sniff.rejected;
      upstreamResp = sniff.response;
    }
    {
      const outcome = await retryOnPlanExhausted({
        rejected: planRejected,
        plan,
        priority: planPriorityOf(config),
        onFallback: (message) => {
          console.log(`${reqId} ${message}`);
          appendErrorLog({ kind: "plan_fallback", reqId, message, ...clientTraceFields(clientReq) });
        },
        rebuildAndDispatch: rebuildForPlan,
      });
      if (outcome.handled && outcome.resp) {
        plan = outcome.target ?? plan;
        startPlan = plan === "start-plan";
        meta.plan = plan;
        upstreamResp = outcome.resp;
        // The fallback's own answer must pass the same sniff when it landed on
        // the start-plan gateway: with every plan exhausted the retry comes
        // back as a 200 quota envelope (live 2026-10-06: Claude Code saw
        // "JSON but not a Message" + 0 stream events). A rejected envelope
        // becomes a clean 429 instead of a fake 200.
        if (startPlan && upstreamResp.status === 200) {
          const sniff = await sniffStartPlanRejection(upstreamResp);
          if (sniff.rejected) {
            appendErrorLog({ kind: "plan_quota_exhausted", reqId, message: "fallback also rejected — both plans exhausted", ...clientTraceFields(clientReq) });
            printRow(reqId, format, meta, 429, started, headersAt, 0, 0, 0);
            return errorResponse(429, "plan_quota_exhausted", "the upstream rejected the request on both plans (the fallback also got a quota envelope)");
          }
          upstreamResp = sniff.response;
        }
      }
    }
  }

  if (upstreamResp.status === 401 && startPlan) {
    if (debug) debugError(reqId, "start_plan_jwt_invalid", "JWT rejected upstream");
    printRow(reqId, format, meta, 401, started, headersAt, 0, 0, 0);
    return errorResponse(401, "start_plan_jwt_invalid", "Start-plan JWT was rejected. Re-run: zcode-proxy auth login");
  }

  // start-plan: on explicit captcha challenge, retry once with a fresh
  // pooled token (the challenged token was already consumed by this request;
  // getCaptchaToken takes the next pre-solved one). Detection covers the
  // response-header variant AND the in-body `{"code":3007}` variant (observed
  // 2026-08-29 as HTTP 400 JSON with no captcha header) via the shared
  // captcha-retry seam (used by /v1/responses too).
  const captcha = startPlan ? (opts.captcha ?? (await loadCaptcha())) : null;
  const captchaChallenge = captcha ? await isCaptchaChallenged(upstreamResp, captcha) : false;
  if (captchaChallenge && captcha) {
    console.log(`${reqId} captcha challenge, re-solving...`);
    const outcome = await retryOnCaptchaChallenge({
      captcha,
      appVersion: config.identity.appVersion,
      challengedResp: upstreamResp,
      debug: debug ? (message) => debugLine(reqId, message) : undefined,
      solveAndRetry: (retryHeaders) => {
        console.log(`${reqId} captcha re-solved (token ${retryHeaders[captcha.RETRY_HEADERS.PARAM].length} chars), retrying...`);
        upstreamHeaderPairs = buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, config.identity, plan, retryHeaders, clientSession);
        if (useOrderedTransport && translateMode) {
          upstreamHeaderPairs = capOrderedAcceptEncoding(upstreamHeaderPairs);
        }
        upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, provider, cred, transformedBody, config.identity, plan, retryHeaders, clientSession);
        return dispatch(upstreamReq, upstreamHeaderPairs).then((resp) => {
          if (debug) debugLine(reqId, `← retry ${resp.status} ${resp.statusText}`);
          return resp;
        });
      },
      mapError: (err, phase) => {
        if (phase === "solver") {
          if (debug) debugError(reqId, "captcha_solver_failed", err.message);
          printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
          return errorResponse(503, "captcha_solver_failed", err.message);
        }
        if (debug) debugError(reqId, "upstream_unreachable", err.message);
        printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
        return errorResponse(502, "upstream_unreachable", unreachableMessage(err));
      },
    });
    if (!outcome.ok) return outcome.resp;
    upstreamResp = outcome.resp;
  }

  const isSSE = upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false;

  if (translateOpenAIToAnthropic) {
    if (!upstreamResp.ok) {
      const errBody = await upstreamResp.text().catch(() => "");
      printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
      return errorResponse(502, "translation_failed", `upstream returned ${upstreamResp.status}: ${errBody.slice(0, 200)}`);
    }
    if (isSSE && upstreamResp.body) {
      if (!meta.stream) {
        // Batch-as-stream (see withStreamEnabled): a batch OpenAI client gets
        // the reassembled JSON, not a stream it never asked for.
        const batch = await translatedBatchResponse(clientReq, upstreamResp, meta.model, reqId, format, meta, started, headersAt);
        noteInFlightEnded();
        return batch;
      }
      const translated = anthropicSseToOpenaiSse(upstreamResp.body, meta.model);
      const [clientBody, statsBody] = translated.tee();
      observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, null, noteInFlightEnded);
      return translatedSseResponse(clientBody);
    }
    const batchResp = await translatedBatchResponse(clientReq, upstreamResp, meta.model, reqId, format, meta, started, headersAt);
    noteInFlightEnded();
    return batchResp;
  }

  if (translateAnthropicToOpenAI) {
    if (!upstreamResp.ok) {
      const errBody = await upstreamResp.text().catch(() => "");
      printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
      return errorResponse(502, "translation_failed", `upstream returned ${upstreamResp.status}: ${errBody.slice(0, 200)}`);
    }
    if (isSSE && upstreamResp.body) {
      const translated = openaiSseToAnthropicSse(upstreamResp.body, meta.model);
      const [clientBody, statsBody] = translated.tee();
      observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, null, noteInFlightEnded);
      return translatedSseResponse(clientBody);
    }
    const batchResp = await translatedOpenAIToAnthropicBatchResponse(clientReq, upstreamResp, reqId, format, meta, started, headersAt);
    noteInFlightEnded();
    return batchResp;
  }

  if (isSSE && upstreamResp.body) {
    if (!meta.stream) {
      // Our own batch-as-stream injection (see withStreamEnabled): the client
      // asked for a single JSON, so reassemble the stream into it.
      const collected = await collectedBatchResponse(upstreamResp, clientReq, reqId, format, meta, started, headersAt);
      noteInFlightEnded();
      return collected;
    }
    const [clientBody, statsBody] = upstreamResp.body.tee();
    observeStream(reqId, format, meta, upstreamResp.status, started, statsBody, upstreamResp.headers.get("content-encoding"), noteInFlightEnded);
    return passthroughResponse(upstreamResp, clientReq.headers.get("accept-encoding"), clientBody);
  }

  if (isCountTokens && upstreamResp.ok) {
    const text = await upstreamResp.text().catch(() => "");
    let inputTokens = 0;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.input_tokens === "number") inputTokens = parsed.input_tokens;
    } catch {}
    printRow(reqId, format, meta, upstreamResp.status, started, headersAt, 0, 0, 0, 0, inputTokens);
    noteInFlightEnded();
    return new Response(text, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: upstreamResp.headers,
    });
  }

  printRow(reqId, format, meta, upstreamResp.status, started, headersAt, 0, 0, 0);
  noteInFlightEnded();
  return passthroughResponse(upstreamResp, clientReq.headers.get("accept-encoding"));
}

export function shouldUseOrderedTransport(clientSession: ClientSessionResult | undefined, hasCustomFetchImpl: boolean): boolean {
  if (hasCustomFetchImpl) return false;
  return clientSession?.action === "enforce" || clientSession?.source === "explicit";
}

/**
 * Restrict an ordered-transport header-pair list's `accept-encoding` to codings
 * the transport can inflate itself (see ordered-transport.ts). Preserves the
 * client's token order, drops q-weights and unsupported tokens (including `*`),
 * and falls back to `identity` when nothing remains. Header order is untouched —
 * only the value at the existing position changes.
 */
export function capOrderedAcceptEncoding(
  pairs: UpstreamHeaderPair[],
  supported: readonly string[] = orderedAdvertisedCodings(),
): UpstreamHeaderPair[] {
  const idx = pairs.findIndex(([name]) => name.toLowerCase() === "accept-encoding");
  if (idx < 0) return pairs;
  const advertised = pairs[idx][1];
  const tokens = advertised
    .split(",")
    .map((token) => token.split(";")[0]!.trim().toLowerCase())
    .filter((token) => token.length > 0);
  const kept = tokens.filter((token) => token === "identity" || supported.includes(token));
  if (kept.length === tokens.length) return pairs;
  const next = kept.length > 0 ? kept.join(", ") : "identity";
  return pairs.map((pair, i) => (i === idx ? [pair[0], next] as UpstreamHeaderPair : pair));
}

/** Max attempts (initial + 2 retries) for transient CONNECT-level failures. */
const MAX_CONNECT_ATTEMPTS = 3;

/** Error thrown when the ladder sees the client signal already aborted. A
 * stable string so the 502 catch site can recognize it without typing. */
export const CLIENT_ABORTED_BEFORE_CONNECT = "client aborted before upstream connect";

/**
 * Connect-level retry ladder shared by the chat hot path and /v1/responses.
 * Transient connect failures (DNS blip, TLS reset, Bun "Unable to connect")
 * happen a few times a day against the gateway; the request never reached
 * upstream, so resending is side-effect-free.
 *
 * Contract (review P1/P2, PR #34/#35):
 *   - `attemptDispatch` must dispatch a FRESH request each call — a reused
 *     Request has its body stream marked used after the first fetch.
 *   - failures flagged `postWrite` (ordered transport already wrote the full
 *     request) are never retried — the upstream may have processed it.
 *   - no retry once the client aborted (`opts.isAborted`).
 */
export async function dispatchWithConnectRetry(
  attemptDispatch: () => Promise<Response>,
  opts: { isAborted?: () => boolean; onRetry?: (attempt: number, err: Error) => void } = {},
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    if (opts.isAborted?.()) throw new Error(CLIENT_ABORTED_BEFORE_CONNECT);
    try {
      return await attemptDispatch();
    } catch (err) {
      if ((err as { postWrite?: boolean }).postWrite) throw err;
      if (attempt >= MAX_CONNECT_ATTEMPTS) throw err;
      const backoffMs = 500 * attempt;
      opts.onRetry?.(attempt, err as Error);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

/** Gateway-produced statuses the upstream answered COMPLETELY (LB timeout or
 * dead backend behind a live load balancer). The model backend produced no
 * output for these, so a single clean resend is side-effect-free in practice. */
export const GATEWAY_RETRY_STATUSES = new Set([502, 504]);

/** Pause before the single gateway-error retry. */
export const GATEWAY_RETRY_BACKOFF_MS = 1000;

/**
 * Single retry for a COMPLETE upstream response carrying a gateway failure
 * status (502/504). Complements `dispatchWithConnectRetry`, which only covers
 * thrown connect errors: an LB 502/504 arrives as a normal Response after
 * 30-180s of gateway-side waiting (observed live 2026-10-04 as batch 502@30s
 * and 504@60s rows) and previously passed straight through to the client.
 * The failed response body is cancelled to release the socket, then `send`
 * runs once more — same contract as the connect ladder: `send` must dispatch
 * a FRESH request each call. Exactly one retry, so a sustained upstream
 * outage never multiplies the client's wait. A client that already hung up
 * skips the retry (nobody receives it) — reported through `onAbort` so the
 * request log distinguishes a retried failure from a skipped one. Both
 * callbacks receive the failed Response so callers can log its x-request-id.
 */
export async function retryOnGatewayError(
  send: () => Promise<Response>,
  opts: { isAborted?: () => boolean; onRetry?: (status: number, resp: Response) => void; onAbort?: (status: number, resp: Response) => void } = {},
): Promise<Response> {
  const resp = await send();
  if (!GATEWAY_RETRY_STATUSES.has(resp.status)) return resp;
  if (opts.isAborted?.()) {
    opts.onAbort?.(resp.status, resp);
    return resp;
  }
  try {
    await resp.body?.cancel();
  } catch {
    // body already closed — nothing to release
  }
  opts.onRetry?.(resp.status, resp);
  await new Promise((r) => setTimeout(r, GATEWAY_RETRY_BACKOFF_MS));
  return send();
}

/**
 * Codings a runtime is ASSUMED to auto-decode, used only when the probe in
 * decompress-probe.ts fails (legacy behavior from the days of the hardcoded
 * `typeof Bun === "undefined"` sniff — verified empirically against Node
 * 22/26 undici and Bun 1.3 back then). The real answer is measured.
 */
const ASSUMED_AUTO_DECODED_ENCODINGS: ReadonlySet<string> = new Set(["gzip", "x-gzip", "deflate", "br"]);

interface FetchDecompressBehavior {
  /** Codings this runtime's fetch inflates even when asked not to (undici). */
  autoDecoded: ReadonlySet<string>;
}

let measuredBehavior: Promise<FetchDecompressBehavior> | null = null;

/**
 * Measured-once decompress behavior of THIS runtime's fetch (see
 * decompress-probe.ts). Falls back to the Node-like assumption with a warning
 * when the probe fails — the stale labels are then still stripped for the
 * known codings, never wrongly kept silent.
 */
function getFetchDecompressBehavior(): Promise<FetchDecompressBehavior> {
  if (!measuredBehavior) {
    measuredBehavior = probeFetchDecompressBehavior().then(
      (autoDecoded) => ({ autoDecoded }),
      (err: unknown) => {
        console.log(`[proxy] decompress probe failed (${(err as Error).message}); assuming auto-decode of ${[...ASSUMED_AUTO_DECODED_ENCODINGS].join(", ")}`);
        return { autoDecoded: ASSUMED_AUTO_DECODED_ENCODINGS };
      },
    );
  }
  return measuredBehavior;
}

/**
 * Strip `content-encoding`/`content-length` from a Response whose body the
 * runtime fetch has ALREADY inflated (the measured `autoDecoded` set). Without
 * this, passthrough on an auto-decoding runtime would forward a decoded body
 * still labeled `content-encoding: gzip` — clients that advertise gzip then
 * fail to decompress it, and the `passthroughResponse` safety net would
 * double-decompress an already-inflated stream for clients that don't. No-op
 * for encodings outside the set — an unknown coding keeps its truthful
 * (possibly stale-looking) header rather than a guessed one. Returns a new
 * Response because a fetch Response's headers can be immutable.
 */
export function stripAutoDecodedEncoding(resp: Response, autoDecoded: ReadonlySet<string> = ASSUMED_AUTO_DECODED_ENCODINGS): Response {
  const encoding = resp.headers.get("content-encoding")?.toLowerCase().trim() ?? "";
  if (!encoding) return resp;
  const codings = encoding.split(",").map((c) => c.trim());
  if (!codings.every((c) => autoDecoded.has(c))) return resp;
  const headers = new Headers(resp.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

async function sendUpstreamRequest(
  upstreamReq: Request,
  headerPairs: UpstreamHeaderPair[],
  body: string | undefined,
  translateMode: boolean,
  useOrderedTransport: boolean,
  fetchImpl: typeof fetch,
  abortSignal?: AbortSignal,
  hasCustomFetchImpl = false,
): Promise<Response> {
  if (useOrderedTransport) {
    return sendOrderedUpstreamRequest({
      url: upstreamReq.url,
      method: upstreamReq.method,
      headers: headerPairs,
      body,
      decompress: translateMode,
      signal: abortSignal,
    });
  }
  const fetchOpts: RequestInit & { decompress?: boolean } = translateMode ? {} : { decompress: false };
  if (abortSignal) fetchOpts.signal = abortSignal;
  const resp = await fetchImpl(upstreamReq, fetchOpts);
  // Passthrough on a runtime whose fetch auto-decompresses (measured once at
  // first use by decompress-probe.ts: undici (Node fetch) decodes
  // gzip/deflate/br and keeps the stale labels, Bun's decompress:false does
  // not): the body arrives inflated while its headers still claim compression.
  // Drop the stale labels so the body/header pairing downstream stays
  // truthful. Skipped for injected fetch impls (tests) — their bodies are
  // genuinely compressed and their decompression semantics are their own.
  if (!translateMode && !hasCustomFetchImpl) {
    const { autoDecoded } = await getFetchDecompressBehavior();
    return stripAutoDecodedEncoding(resp, autoDecoded);
  }
  return resp;
}

/**
 * Read the request body as a string, returning undefined for empty bodies.
 * Transparently inflates compressed request bodies — every coding in
 * `content-encoding` that this runtime can inflate (gzip/x-gzip/deflate/br;
 * `deflate` retries once as raw-deflate for the classic ambiguous clients).
 * Without this, clients that send compressed bodies got a misleading
 * "body is not valid JSON" 400 instead of an encoding diagnosis. Corrupt data
 * throws a descriptive Error naming the codings; inflation past
 * `MAX_INFLATED_BODY_BYTES` throws `InflatedBodyTooLargeError` (streamed +
 * aborted early, so a small wire payload cannot expand into unbounded proxy
 * memory).
 */
export async function readBody(req: Request): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) return undefined;
  const codings = req.headers.get("content-encoding")?.toLowerCase().split(",").map((c) => c.trim()).filter((c) => c !== "" && c !== "identity") ?? [];
  if (codings.length > 0) {
    return new TextDecoder().decode(await inflateRequestBody(bytes, codings));
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Decompressed-size ceiling for gzip request bodies. Generous by design:
 * plain bodies on `/v1/*` routes are intentionally uncapped (long-context LLM
 * requests reach several MB), so this only rejects pathological amplification.
 */
const MAX_INFLATED_BODY_BYTES = 64 * 1024 * 1024;

/** Thrown when a compressed request body expands past MAX_INFLATED_BODY_BYTES. */
export class InflatedBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes after decompression`);
    this.name = "InflatedBodyTooLargeError";
  }
}

/**
 * Inflates a compressed request body through every coding in the
 * content-encoding list (outermost last). Unknown to this runtime → a
 * descriptive 400 source error naming the coding; corrupt data → an error
 * naming the codings (`deflate` retries once as raw-deflate first — some
 * clients label raw-deflate bodies as `deflate`).
 */
async function inflateRequestBody(bytes: Uint8Array, codings: string[]): Promise<Uint8Array> {
  let current = bytes;
  for (let i = codings.length - 1; i >= 0; i--) {
    const coding = codings[i];
    const format = inflateFormatFor(coding);
    if (format === null) {
      throw new Error(`request body is marked content-encoding: ${coding} but this runtime cannot inflate it`);
    }
    let result = await inflateWithCap(current, MAX_INFLATED_BODY_BYTES, format);
    if (!result.ok && result.reason === "corrupt" && format === "deflate") {
      result = await inflateWithCap(current, MAX_INFLATED_BODY_BYTES, "deflate-raw");
    }
    if (!result.ok) {
      if (result.reason === "too_large") throw new InflatedBodyTooLargeError(MAX_INFLATED_BODY_BYTES);
      throw new Error(`request body is marked content-encoding: ${codings.join(", ")} but failed to decompress as ${coding}: ${result.detail}`);
    }
    current = result.bytes;
  }
  return current;
}

/**
 * Create a passthrough response that streams the upstream body to the client.
 * Preserves status and the allowlisted headers, and honors the client's
 * `Accept-Encoding`.
 *
 * The upstream request FORWARDS the client's `accept-encoding` (only
 * defaulting to "gzip" when the client sent none — see
 * `buildUpstreamHeaderPairs`), so the upstream compresses only when the
 * client can decode it. Safety net for upstreams that compress anyway: when
 * the client cannot decode some coding in the response's `content-encoding`
 * list and this runtime can inflate the whole list, inflate before forwarding
 * and drop the now-mismatched `content-encoding`/`content-length` headers —
 * otherwise clients whose HTTP stack does not auto-decompress (e.g. some
 * Tauri-based clients) receive raw compressed bytes and fail to parse the
 * JSON body with "non-JSON body" errors despite a 200 status. When the list
 * cannot be inflated here, forward raw with the truthful header: a visible
 * decode error beats a silent body/header lie.
 */
function passthroughResponse(
  upstream: Response,
  clientAcceptEncoding: string | null,
  body?: ReadableStream<Uint8Array>,
): Response {
  const headers = new Headers();
  const forwardHeaders = [
    "content-type",
    "content-encoding",
    "cache-control",
    "x-request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
  ];

  for (const h of forwardHeaders) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }

  const codings = headers.get("content-encoding")?.toLowerCase().split(",").map((c) => c.trim()).filter((c) => c !== "" && c !== "identity") ?? [];
  const source = body ?? upstream.body;
  const clientDecodesAll = codings.every((coding) => clientAcceptsCoding(clientAcceptEncoding, coding));
  if (codings.length > 0 && !clientDecodesAll && source) {
    const inflated = inflateStreamForCodings(source, codings);
    if (inflated) {
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(inflated, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }
  }

  return new Response(source, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/**
 * Client-facing detail for a failed upstream connect. The raw error message
 * is often EMPTY (a bare connect reset), which left the client a useless
 * `{"message":""}` — always name the problem instead.
 */
export function unreachableMessage(err: unknown): string {
  const detail = (err as Error)?.message?.trim();
  return detail ? `can't connect to z.ai (${detail})` : "can't connect to z.ai";
}

/** Build a JSON error response. */
export function errorResponse(status: number, type: string, message: string): Response {
  // Server-side failures (5xx) land in the persistent error log too — this is
  // the choke point for every module's error responses (chat rows also record
  // a `request_error` line via printRow; the kinds distinguish the views).
  if (status >= 500) {
    appendErrorLog({ kind: "error_response", status, type, message });
  }
  const body = JSON.stringify({
    error: { type, message },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Translate an OpenAI request body string to Anthropic JSON. Returns error Response on failure. */
function translateOpenAIBody(body: string | undefined): Response | string | undefined {
  if (body === undefined || body.length === 0) {
    return errorResponse(400, "translation_failed", "OpenAI request body is empty; cannot translate.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return errorResponse(400, "translation_failed", `OpenAI request body is not valid JSON: ${(err as Error).message}`);
  }
  try {
    const translated = translateRequestOpenAIToAnthropic(parsed as OpenAIChatRequest);
    return JSON.stringify(translated);
  } catch (err) {
    return errorResponse(400, "translation_failed", `OpenAI→Anthropic translation failed: ${(err as Error).message}`);
  }
}

/** True when the client request explicitly accepts gzip (and has not disabled it via q=0). */
function clientAcceptsGzip(req: Request): boolean {
  return clientAcceptsCoding(req.headers.get("accept-encoding"), "gzip");
}

/** Build a translated batch (non-streaming) OpenAI response. Gzip if client accepts. */
/**
 * Shared tail of the three batch-response builders: JSON payload, forwarded
 * upstream headers, optional gzip for clients that advertise it, and the
 * request-log row carrying the real token count.
 */
function batchJsonResponse(
  upstream: Response,
  clientReq: Request,
  json: string,
  outputTokens: number,
  reqId: string,
  format: Format,
  meta: RequestMeta,
  started: number,
  headersAt: number,
  cachedTokens = 0,
  inputTokens = 0,
): Response {
  const payload = new TextEncoder().encode(json);
  const respHeaders = new Headers();
  respHeaders.set("content-type", "application/json");
  for (const h of forwardedUpstreamHeaders()) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  if (clientAcceptsGzip(clientReq)) {
    respHeaders.set("content-encoding", "gzip");
    printRow(reqId, format, meta, upstream.status, started, headersAt, outputTokens, 0, 0, cachedTokens, inputTokens);
    return new Response(gzipSync(payload), { status: upstream.status, headers: respHeaders });
  }
  printRow(reqId, format, meta, upstream.status, started, headersAt, outputTokens, 0, 0, cachedTokens, inputTokens);
  return new Response(payload, { status: upstream.status, headers: respHeaders });
}

async function translatedBatchResponse(
  clientReq: Request,
  upstream: Response,
  model: string,
  reqId: string,
  format: Format,
  meta: RequestMeta,
  started: number,
  headersAt: number,
): Promise<Response> {
  let parsedAnthropic: AnthropicMessagesResponse;
  if (isEventStream(upstream) && upstream.body) {
    try {
      parsedAnthropic = await collectAnthropicMessage(upstream.body, upstreamCodings(upstream));
    } catch (err) {
      printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
      return errorResponse(502, "upstream_stream_failed", (err as Error).message);
    }
  } else {
    const raw = await upstream.text();
    try {
      parsedAnthropic = JSON.parse(raw) as AnthropicMessagesResponse;
    } catch (err) {
      printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
      return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
    }
  }
  if (!isAnthropicMessagesResponse(parsedAnthropic)) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
    return errorResponse(502, "translation_failed", `upstream returned invalid Anthropic message: ${JSON.stringify(parsedAnthropic).slice(0, 200)}`);
  }
  const openaiResp = translateResponseAnthropicToOpenAI(parsedAnthropic, model);
  const cachedTokens = openaiResp.usage?.prompt_tokens_details?.cached_tokens ?? parsedAnthropic.usage?.cache_read_input_tokens ?? 0;
  const inputTokens = parsedAnthropic.usage?.input_tokens ?? Math.max(0, (openaiResp.usage?.prompt_tokens ?? 0) - cachedTokens);
  return batchJsonResponse(upstream, clientReq, JSON.stringify(openaiResp), openaiResp.usage?.completion_tokens ?? 0, reqId, format, meta, started, headersAt, cachedTokens, inputTokens);
}

async function translatedOpenAIToAnthropicBatchResponse(
  clientReq: Request,
  upstream: Response,
  reqId: string,
  format: Format,
  meta: RequestMeta,
  started: number,
  headersAt: number,
): Promise<Response> {
  const raw = await upstream.text();
  let parsedOpenAI: OpenAIChatResponse;
  try {
    parsedOpenAI = JSON.parse(raw) as OpenAIChatResponse;
  } catch (err) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
  }
  const anthropicResp = translateResponseOpenAIToAnthropic(parsedOpenAI);
  const cachedTokens = parsedOpenAI.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const inputTokens = anthropicResp.usage.input_tokens;
  return batchJsonResponse(upstream, clientReq, JSON.stringify(anthropicResp), anthropicResp.usage.output_tokens, reqId, format, meta, started, headersAt, cachedTokens, inputTokens);
}

function translateAnthropicBody(body: string | undefined): Response | string | undefined {
  if (body === undefined || body.length === 0) {
    return errorResponse(400, "translation_failed", "Anthropic request body is empty; cannot translate.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return errorResponse(400, "translation_failed", `Anthropic request body is not valid JSON: ${(err as Error).message}`);
  }
  try {
    const translated = translateRequestAnthropicToOpenAI(parsed as AnthropicMessagesRequest);
    return JSON.stringify(translated);
  } catch (err) {
    return errorResponse(400, "translation_failed", `Anthropic→OpenAI translation failed: ${(err as Error).message}`);
  }
}

function isAnthropicMessagesResponse(value: unknown): value is AnthropicMessagesResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AnthropicMessagesResponse>;
  return candidate.type === "message" && candidate.role === "assistant" && Array.isArray(candidate.content);
}

function forwardedUpstreamHeaders(): string[] {
  return [
    "x-request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
  ];
}

function translatedSseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

export interface RequestMeta {
  model: string;
  stream: boolean;
  countTokens?: boolean;
  /** Plan the request is served on, set by proxyRequest after resolution. */
  plan?: PlanTier;
  /** Client-supplied correlation ids (clientTraceFields), copied into error-log entries. */
  clientRequestId?: string;
  clientSessionId?: string;
  /** The upstream's x-request-id, set after dispatch, copied into error-log entries. */
  upstreamRequestId?: string;
}

function peekBody(body: string | undefined): RequestMeta {
  if (!body) return { model: "-", stream: false };
  try {
    const p = JSON.parse(body) as Record<string, unknown>;
    return {
      model: typeof p.model === "string" ? p.model : "-",
      stream: p.stream === true,
    };
  } catch {
    return { model: "-", stream: false };
  }
}

/** Enable `stream: true` on a JSON request body (no-op on parse failure). */
export function withStreamEnabled(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed.stream === true) return body;
    parsed.stream = true;
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

export function isEventStream(resp: Response): boolean {
  return resp.headers.get("content-type")?.includes("text/event-stream") ?? false;
}

/** The response's non-identity content-encoding list (for collector inflation). */
export function upstreamCodings(resp: Response): string[] {
  return resp.headers.get("content-encoding")?.toLowerCase().split(",").map((c) => c.trim()).filter((c) => c !== "" && c !== "identity") ?? [];
}

/**
 * The gateway's own request id: the handle to quote when correlating an
 * upstream failure with the provider's side of the story.
 */
export function upstreamRequestId(resp: Response): string | undefined {
  return resp.headers.get("x-request-id") ?? undefined;
}

/**
 * Reassemble a batch-as-stream upstream response into the single Anthropic
 * JSON the batch client expects (see `withStreamEnabled`). Collect failures
 * (error events, truncation) surface as 502 with the reason logged.
 */
async function collectedBatchResponse(
  upstream: Response,
  clientReq: Request,
  reqId: string,
  format: Format,
  meta: RequestMeta,
  started: number,
  headersAt: number,
): Promise<Response> {
  let message: AnthropicMessagesResponse;
  try {
    message = await collectAnthropicMessage(upstream.body!, upstreamCodings(upstream));
  } catch (err) {
    console.log(`${reqId} upstream stream collect failed: ${(err as Error).message}`);
    appendErrorLog({ kind: "stream_collect_failed", reqId, error: (err as Error).message, upstreamRequestId: upstreamRequestId(upstream), ...clientTraceFields(clientReq) });
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
    return errorResponse(502, "upstream_stream_failed", (err as Error).message);
  }
  const cachedTokens = message.usage?.cache_read_input_tokens ?? 0;
  const inputTokens = message.usage?.input_tokens ?? 0;
  return batchJsonResponse(upstream, clientReq, JSON.stringify(message), message.usage?.output_tokens ?? 0, reqId, format, meta, started, headersAt, cachedTokens, inputTokens);
}

let reqCounter = 0;
let headerPrinted = false;

/** Format a unix-ms timestamp as local HH:MM:SS in the host's timezone (not UTC). */
function localTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// The persistent errors.log survives restarts, so a bare counter collides
// across runs (every run has a #001). A per-boot 4-hex token keeps the id
// short enough for the request-log table while making each run's ids unique
// in the file: `a1b2-#001` vs a later boot's `c3d4-#001`.
const BOOT_TOKEN = randomBytes(2).toString("hex");

/** Display width of a request id (`741f-#001`): boot token, dash, # + 3-digit counter. */
const REQ_ID_WIDTH = BOOT_TOKEN.length + 5;

function nextReqId(): string {
  return `${BOOT_TOKEN}-#${String(++reqCounter).padStart(3, "0")}`;
}

/**
 * Pair a start-plan custom-system request with the subagent session identity.
 * Returns the session unchanged for every other request.
 */
function applyCustomSystemSession(
  session: ClientSessionResult | undefined,
  startPlan: boolean,
  body: string | undefined,
  debug: boolean,
  reqId: string,
): ClientSessionResult | undefined {
  if (!startPlan || !bodyHasClientSystem(body)) return session;
  if (debug) debugLine(reqId, "subagent session identity applied (custom system prompt path)");
  return subagentSession(session);
}

/**
 * Subagent session identity for the custom-system path: the same resolved
 * session id with a `subagent_agent_` prefix (stripped on the wire by the
 * trace-header builder, derivation only), or a synthesized id when lineage
 * produced none. The explicit `sessionType` covers the no-session-id case.
 */
function subagentSession(base: ClientSessionResult | undefined): ClientSessionResult {
  if (!base) {
    return {
      source: "none",
      action: "enforce",
      confidence: 1,
      sessionId: `${SUBAGENT_PREFIX}${crypto.randomUUID()}`,
      sessionType: "subagent",
    };
  }
  const id = base.upstreamSessionId ?? base.sessionId ?? crypto.randomUUID();
  const subagentId = id.startsWith(SUBAGENT_PREFIX) ? id : `${SUBAGENT_PREFIX}${id}`;
  return { ...base, sessionId: subagentId, upstreamSessionId: subagentId, sessionType: "subagent" };
}

/**
 * Whether the (Anthropic-shaped) upstream body carries a client system prompt
 * — i.e. transformRequestBody will take the customSystemPrompt 2-block path.
 * Same predicate as buildStartPlanSystem via hasCustomSystemPrompt; parse
 * failures read as "no custom prompt" (fail-open to the default shape).
 */
function bodyHasClientSystem(body: string | undefined): boolean {
  if (!body) return false;
  try {
    const parsed = JSON.parse(body) as { system?: unknown };
    return hasCustomSystemPrompt(parsed?.system);
  } catch {
    return false;
  }
}

const DEBUG_BODY_PREVIEW = 200;
const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "cookie", "set-cookie", "proxy-authorization"]);

function debugLine(reqId: string, msg: string): void {
  console.log(`${reqId} debug: ${msg}`);
}

function debugError(reqId: string, kind: string, msg: string): void {
  console.log(`${reqId} debug: ERROR ${kind}: ${msg}`);
}

function redactHeaderVal(key: string, val: string): string {
  const k = key.toLowerCase();
  if (!SENSITIVE_HEADERS.has(k)) return val;
  if (k === "authorization") {
    const sp = val.indexOf(" ");
    return sp > 0 ? `${val.slice(0, sp)} <redacted>` : "<redacted>";
  }
  if (val.length <= 10) return "<redacted>";
  return `${val.slice(0, 6)}...${val.slice(-4)}`;
}

function formatHeaderPairs(headers: Headers): string {
  const pairs: string[] = [];
  for (const [k, v] of headers.entries()) {
    pairs.push(`${k}=${redactHeaderVal(k, v)}`);
  }
  return pairs.join(" ");
}

function formatResponseHeaders(headers: Headers): string {
  const interesting = [
    "content-type",
    "content-encoding",
    "content-length",
    "x-request-id",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-tokens-remaining",
  ];
  const pairs: string[] = [];
  for (const h of interesting) {
    const v = headers.get(h);
    if (v) pairs.push(`${h}=${v}`);
  }
  return pairs.length > 0 ? pairs.join(" ") : "(no notable headers)";
}

function previewBody(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= DEBUG_BODY_PREVIEW) return flat;
  return `${flat.slice(0, DEBUG_BODY_PREVIEW)}…(${flat.length} bytes total)`;
}

const COMPACT_LOG = process.env.ZCODE_LOG_FORMAT === "compact";

function printHeader(): void {
  if (headerPrinted) return;
  headerPrinted = true;
  if (COMPACT_LOG) return;
  // First column matches REQ_ID_WIDTH (a boot-scoped id like `741f-#001`),
  // the Model column the longest known model name (`glm-5.3-flash`, 13).
  console.log(
    "| #         | Time       | Fmt | Plan        | Model         | Mode   | Stat |    TTFB |   Input |   Cache |  Output |  tok/s |   Total |",
  );
  console.log(
    "|-----------|------------|-----|-------------|---------------|--------|------|---------|---------|---------|---------|--------|---------|",
  );
}

export function printRow(
  reqId: string,
  format: Format,
  meta: RequestMeta,
  status: number,
  started: number,
  headersAt: number,
  tokens: number,
  avgTps: number,
  streamEndAt: number,
  cachedTokens = 0,
  inputTokens = 0,
): void {
  if (status >= 400) recordRequestError(reqId, format, meta, status, started, headersAt, tokens, streamEndAt);
  printHeader();
  const tag = format === "anthropic" ? "ANT" : "OAI";
  const mode = meta.countTokens ? "count" : meta.stream ? "stream" : "batch";

  if (COMPACT_LOG) {
    const ttfbMs = headersAt - started;
    const totalMs = streamEndAt > started ? streamEndAt - started : ttfbMs;
    const ttfbStr = fmtMs(ttfbMs);
    const inStr = inputTokens > 0 ? `${inputTokens}in` : "";
    const cacheStr = cachedTokens > 0 ? `${cachedTokens}cache` : "";
    const outStr = tokens > 0 ? `${tokens}out` : "";
    const tpsStr = avgTps > 0 ? `${avgTps.toFixed(0)}t/s` : "";
    const parts = [reqId, tag, meta.model, String(status), mode];
    if (meta.stream && streamEndAt > started) {
      parts.push(`${ttfbStr}→${fmtMs(totalMs)}`);
    } else {
      parts.push(ttfbStr);
    }
    if (inStr) parts.push(inStr);
    if (cacheStr) parts.push(cacheStr);
    if (outStr) parts.push(outStr);
    if (tpsStr) parts.push(tpsStr);
    console.log(parts.join(" "));
    return;
  }

  const ts = localTime(started);
  // Human-readable durations (same format the compact log uses): ms below
  // 1s, seconds below 1m, `NmNs` above — a 60s stream must not read "60054ms".
  const ttfb = fmtMs(headersAt - started);
  const total = streamEndAt > started ? fmtMs(streamEndAt - started) : "-";
  const inTok = inputTokens > 0 ? String(inputTokens) : "-";
  const cacheTok = cachedTokens > 0 ? String(cachedTokens) : "-";
  const outTok = tokens > 0 ? String(tokens) : "-";
  const tps = avgTps > 0 ? avgTps.toFixed(1) : "-";
  console.log(
    `| ${reqId.padEnd(REQ_ID_WIDTH)} | ${ts.padEnd(10)} | ${tag} | ${(meta.plan ?? "-").padEnd(11)} | ${meta.model.padEnd(13)} | ${mode.padEnd(6)} | ${String(status).padStart(4)} | ${ttfb.padStart(7)} | ${inTok.padStart(7)} | ${cacheTok.padStart(7)} | ${outTok.padStart(7)} | ${tps.padStart(6)} | ${total.padStart(7)} |`,
  );
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

/** Persistent error log for every request the client could see fail (4xx/5xx):
 * lands in the data dir's errors.log with timings (see error-log.ts). */
function recordRequestError(
  reqId: string,
  format: Format,
  meta: RequestMeta,
  status: number,
  started: number,
  headersAt: number,
  tokens: number,
  streamEndAt: number,
): void {
  appendErrorLog({
    kind: "request_error",
    reqId,
    format: format === "anthropic" ? "ANT" : "OAI",
    plan: meta.plan,
    model: meta.model,
    mode: meta.stream ? "stream" : "batch",
    status,
    ttfbMs: headersAt - started,
    totalMs: streamEndAt > started ? streamEndAt - started : undefined,
    tokens: tokens > 0 ? tokens : undefined,
    ...(meta.clientRequestId ? { clientRequestId: meta.clientRequestId } : {}),
    ...(meta.clientSessionId ? { clientSessionId: meta.clientSessionId } : {}),
    ...(meta.upstreamRequestId ? { upstreamRequestId: meta.upstreamRequestId } : {}),
  });
}

function observeStream(
  reqId: string,
  format: Format,
  meta: RequestMeta,
  status: number,
  requestSentAt: number,
  body: ReadableStream<Uint8Array>,
  contentEncoding: string | null,
  onEnd?: () => void,
): void {
  const codings = contentEncoding
    ? contentEncoding.toLowerCase().split(",").map((c) => c.trim()).filter((c) => c !== "" && c !== "identity")
    : [];
  const compressed = codings.length > 0;
  const dumpOn = dumpEnabled();
  const sampleDecoder = new TextDecoder();
  const metrics = new StreamMetrics();
  let sseBuffer = "";
  let firstChunkAt = 0;
  let lastChunkAt = 0;
  let totalBytes = 0;
  let firstBytesSample = "";

  function parseSse(text: string, receivedAt: number): void {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        metrics.observe(j, receivedAt);
      } catch {}
    }
  }

  (async () => {
    const inflated = compressed ? inflateStreamForCodings(body, codings) : null;
    const streamToRead = inflated ?? body;
    const canParseSse = !compressed || inflated !== null;
    const reader = streamToRead.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastChunkAt = performance.now();
        if (firstChunkAt === 0) firstChunkAt = Date.now();
        if (dumpOn && value) {
          totalBytes += value.byteLength;
          if (firstBytesSample.length < 4096) {
            firstBytesSample += sampleDecoder.decode(value.slice(0, 4096 - firstBytesSample.length), { stream: true });
          }
        }
        if (canParseSse && value) {
          sseBuffer += decoder.decode(value, { stream: true });
          const idx = sseBuffer.lastIndexOf("\n");
          if (idx >= 0) {
            parseSse(sseBuffer.slice(0, idx), lastChunkAt);
            sseBuffer = sseBuffer.slice(idx + 1);
          }
        }
      }
      if (canParseSse && sseBuffer) parseSse(sseBuffer, lastChunkAt);
    } catch {}
    const endAt = Date.now();
    // Stream finished (or failed): the request is no longer in flight. Fired
    // exactly once from this reader loop — the single point that observes
    // SSE completion for every streaming response path.
    try { onEnd?.(); } catch (err) {
      console.error(`${reqId} stream-end hook failed: ${(err as Error).message}`);
    }
    const ttfbMs = (firstChunkAt > 0 ? firstChunkAt : endAt) - requestSentAt;
    const totalMs = endAt - requestSentAt;
    const tokens = metrics.tokens;
    const avgTps = metrics.tokensPerSecond;
    printRow(reqId, format, meta, status, requestSentAt, requestSentAt + ttfbMs, tokens, avgTps, endAt, metrics.cachedTokens, metrics.inputTokens);
    if (dumpOn) {
      dumpPhase(reqId, "upstream_stream_summary", {
        status,
        contentEncoding,
        compressed,
        totalBytes,
        inputTokensObserved: metrics.inputTokens,
        cachedTokensObserved: metrics.cachedTokens,
        tokensObserved: tokens,
        generationMs: metrics.generationMs,
        tokensPerSecond: avgTps,
        ttfbMs,
        totalMs,
        firstBytesSample: firstBytesSample.length > 0 ? firstBytesSample.slice(0, 4096) : "(empty stream)",
      });
    }
  })().catch(() => {});
}
