import { createHash } from 'node:crypto';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { config } from '../config.js';
import type { Profile } from '../types.js';
import { Semaphore, SemaphoreBusyError, SingleFlight, TtlLruCache } from './cache.js';

/* ------------------------------------------------------------------ *
 * The separator between encoded source URLs.
 *
 * '%7C' decodes to '|', which is what Subconverter splits on. It is safe
 * to use the ENCODED form because of the order of operations upstream:
 *
 *   1. cpp-httplib percent-decodes every query parameter before
 *      Subconverter ever sees it  (include/httplib.h:4188)
 *   2. Subconverter then copies those decoded params verbatim
 *      (src/server/webserver_httplib.cpp:52)
 *   3. ...and splits the value on "|"  (src/handler/interfaces.cpp:152)
 *
 * Decode happens before split, so '%7C' and a raw '|' are semantically
 * identical at the split point. The tie-break is purely about transport:
 * a raw '|' is not a legal URI character and is rejected by some proxies,
 * WAFs and strict HTTP parsers - a failure that only appears in a proxied
 * deployment, which is the one you cannot reproduce locally.
 *
 * If your particular backend ever misbehaves, changing this one constant
 * to '|' is the whole fix.
 * ------------------------------------------------------------------ */
export const SOURCE_SEPARATOR = '%7C';

const MAX_CONFIG_BYTES = 10 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * Error taxonomy
 * ------------------------------------------------------------------ */

export type ConverterErrorCode =
  | 'NO_SOURCES'
  | 'INVALID_SOURCE_CONFIG'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNREACHABLE'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_EMPTY'
  | 'UPSTREAM_TOO_LARGE'
  | 'SERVER_BUSY'
  | 'CLIENT_ABORTED';

export class ConverterError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ConverterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConverterError';
  }
}

/* ------------------------------------------------------------------ *
 * URL building
 * ------------------------------------------------------------------ */

export interface ConvertRequest {
  target: string;
  /** PLAIN source URLs - not encoded. Encoding happens here. */
  sourceUrls: string[];
  customRuleset?: string | null;
  excludeRemarks?: string | null;
  udp: boolean;
  userAgent?: string;
  /**
   * Backend access token, sent as `&token=`. Deliberately NOT part of the
   * cache key (see cacheKeyFor): it is a credential, not an input that
   * changes the generated config, so it must not fragment the cache.
   */
  token?: string;
}

/**
 * encodeURIComponent each URL, then join with an encoded pipe.
 *
 * This is exactly equivalent to encodeURIComponent(urls.join('|')) and
 * matches Subconverter's documented instruction to join first and encode
 * the whole thing.
 *
 * MUST be encodeURIComponent, never encodeURI: cpp-httplib treats '+' in a
 * decoded query value as a space, so a literal '+' in an opaque token
 * (?token=abc+def) would silently become a space and the upstream fetch
 * would 404. encodeURI also leaves '&' and '#' alone, which would split
 * the url parameter at the query parser.
 */
export function buildSourceUrlParam(sourceUrls: string[]): string {
  return sourceUrls.map((u) => encodeURIComponent(u)).join(SOURCE_SEPARATOR);
}

/**
 * Hand-built query string. Do NOT rewrite this with URLSearchParams.
 *
 * URLSearchParams treats its input as a DECODED string and re-encodes it, so
 * an already-encoded 'https%3A%2F%2F...' becomes 'https%253A%252F%252F...'.
 * cpp-httplib then decodes once, handing Subconverter the literal string
 * 'https%3A%2F%2F...' - which is not a URL, so it fails to fetch it.
 * Symptom: HTTP 200 with an empty config, which looks like a Subconverter
 * bug rather than ours. (new URL(fullString) is fine; only searchParams
 * re-encodes.)
 */
export function buildSubconverterUrl(base: string, req: ConvertRequest): string {
  const params: string[] = [
    `target=${encodeURIComponent(req.target)}`,
    `url=${buildSourceUrlParam(req.sourceUrls)}`,
    `udp=${req.udp ? 'true' : 'false'}`,
  ];

  // Omitted when empty rather than sent as `config=`: an empty value can
  // never mean anything useful here and its handling varies by version.
  if (req.customRuleset) params.push(`config=${encodeURIComponent(req.customRuleset)}`);
  if (req.excludeRemarks) params.push(`exclude=${encodeURIComponent(req.excludeRemarks)}`);
  if (req.token) params.push(`token=${encodeURIComponent(req.token)}`);

  return `${base}/sub?${params.join('&')}`;
}

/* ------------------------------------------------------------------ *
 * Proxy
 * ------------------------------------------------------------------ */

export interface ConvertResult {
  body: ArrayBuffer;
  upstreamStatus: number;
  /** null when the upstream did not send the header. */
  subscriptionUserinfo: string | null;
}

function toTransportError(err: unknown, clientSignal?: AbortSignal): ConverterError {
  if (clientSignal?.aborted) {
    return new ConverterError(499 as ContentfulStatusCode, 'CLIENT_ABORTED', 'client closed the request');
  }
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new ConverterError(504, 'UPSTREAM_TIMEOUT', 'subconverter did not respond in time');
  }
  // Node's fetch throws a bare `TypeError: fetch failed` with the real
  // reason attached as `cause`.
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const detail = cause?.code ?? cause?.message ?? 'connection failed';
  return new ConverterError(502, 'UPSTREAM_UNREACHABLE', `cannot reach subconverter (${detail})`);
}

export async function fetchConvertedConfig(
  req: ConvertRequest,
  opts: { clientSignal?: AbortSignal } = {},
): Promise<ConvertResult> {
  const url = buildSubconverterUrl(config.subconverterUrl, req);

  const signals = [AbortSignal.timeout(config.converterTimeoutMs)];
  if (opts.clientSignal) signals.push(opts.clientSignal);
  const signal = AbortSignal.any(signals);

  const headers: Record<string, string> = { Accept: '*/*' };
  // Forwarded verbatim: some providers gate on UA, returning a Clash config
  // to some clients and a base64 node list to others. Deliberately NOT
  // forwarded: Cookie, Authorization, Referer, Host, Accept-Encoding.
  // Sending client credentials to Subconverter is a leak with no upside.
  if (req.userAgent) headers['User-Agent'] = req.userAgent;

  let res: Response;
  try {
    res = await fetch(url, { headers, signal, redirect: 'follow' });
  } catch (err) {
    throw toTransportError(err, opts.clientSignal);
  }

  if (!res.ok) {
    // Cancel rather than buffer: an error page can be large, and its
    // contents must never be echoed to the client (upstream bodies can
    // contain the source URLs, which are the user's credentials).
    await res.body?.cancel().catch(() => {});
    throw new ConverterError(502, 'UPSTREAM_ERROR', `subconverter responded ${res.status}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    // A live Subconverter never returns HTML on /sub; this is a proxy's
    // error page, which would otherwise be served to the client as a
    // "config" that Clash would fail to parse with a useless message.
    await res.body?.cancel().catch(() => {});
    throw new ConverterError(502, 'UPSTREAM_ERROR', 'subconverter returned an HTML page');
  }

  // Buffered, not streamed. Three reasons: the error paths stay coherent
  // (with a stream you may have already committed a 200 before the body
  // fails, so you cannot send a status), MAX_CONFIG_BYTES is enforceable,
  // and the Node adapter can set Content-Length. Real configs are 100 KiB
  // - 2 MiB, so the memory cost is bounded and trivial. The abort signal
  // still covers this read, so a stalled body is caught.
  let body: ArrayBuffer;
  try {
    body = await res.arrayBuffer();
  } catch (err) {
    throw toTransportError(err, opts.clientSignal);
  }

  if (body.byteLength === 0) throw new ConverterError(502, 'UPSTREAM_EMPTY', 'subconverter returned an empty config');
  if (body.byteLength > MAX_CONFIG_BYTES) {
    throw new ConverterError(502, 'UPSTREAM_TOO_LARGE', 'config exceeds the size limit');
  }

  return {
    body,
    upstreamStatus: res.status,
    // Case-insensitive lookup; null when absent, which is the common case
    // for sources that are plain node lists with no traffic metadata.
    subscriptionUserinfo: res.headers.get('subscription-userinfo'),
  };
}

/* ------------------------------------------------------------------ *
 * Caching
 * ------------------------------------------------------------------ */

// 128 entries is a belt-and-braces cap alongside the byte budget: it bounds
// the cost of eviction scans even if every entry were tiny.
const MAX_CACHE_ENTRIES = 128;

const cache = new TtlLruCache<string, ConvertResult>(
  config.cacheTtlMs,
  MAX_CACHE_ENTRIES,
  config.cacheMaxBytes,
  (result) => result.body.byteLength,
);

const inflight = new SingleFlight<string, ConvertResult>();

/**
 * Caps how many conversions run at once.
 *
 * Deriving the queue length and the acquire timeout rather than exposing them
 * as separate knobs keeps the config surface at one variable while still
 * bounding worst-case latency: a request waits at most CONVERTER_TIMEOUT_MS
 * for a slot, then converts for at most CONVERTER_TIMEOUT_MS more.
 */
const QUEUE_MULTIPLIER = 8;
const semaphore = new Semaphore(
  config.maxConcurrentConversions,
  config.maxConcurrentConversions * QUEUE_MULTIPLIER,
  config.converterTimeoutMs,
);

/**
 * Runs `fn` holding one conversion slot.
 *
 * `acquire` is awaited BEFORE the caller is registered as in-flight, and
 * `release` always runs, so a throwing or timing-out conversion cannot leak a
 * slot permanently.
 */
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  try {
    await semaphore.acquire();
  } catch (err) {
    if (err instanceof SemaphoreBusyError) {
      throw new ConverterError(503, 'SERVER_BUSY', err.message);
    }
    throw err;
  }

  try {
    return await fn();
  } finally {
    semaphore.release();
  }
}

/**
 * The key is a hash of every input that can change the output - which is why
 * it needs no invalidation logic: editing a profile or a source changes the
 * key, so the next request simply misses and refetches. Entries for abandoned
 * keys age out via the TTL.
 *
 * The User-Agent is part of it deliberately. We forward the client's UA to
 * Subconverter, and providers use it to decide what to return (a Clash config
 * for some, a base64 node list for others). Keying on the profile alone would
 * let one client's UA poison the cached response for a different client type.
 */
function cacheKeyFor(req: ConvertRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        target: req.target,
        sourceUrls: req.sourceUrls,
        customRuleset: req.customRuleset ?? null,
        excludeRemarks: req.excludeRemarks ?? null,
        udp: req.udp,
        userAgent: req.userAgent ?? '',
      }),
    )
    .digest('hex');
}

/** Where a result came from. Logged, so the three cases stay distinguishable. */
export type ConvertSource = 'cache' | 'coalesced' | 'fetch';

export interface ConvertLookup {
  result: ConvertResult;
  source: ConvertSource;
}

/**
 * Cache-and-single-flight wrapper around fetchConvertedConfig.
 *
 * Note that clientSignal is deliberately NOT threaded through here. The
 * upstream call is shared between every waiter, so passing one client's abort
 * signal would let that client's disconnect cancel everyone else's request.
 * The timeout still bounds the fetch, and letting it run to completion is
 * actively useful: it warms the cache for the next caller.
 *
 * Only successful conversions are cached. Errors are always retried - caching
 * a 502 because Subconverter was restarting would turn a blip into a TTL-long
 * outage.
 */
export async function getConvertedConfig(
  req: ConvertRequest,
  opts: { bypassCache?: boolean } = {},
): Promise<ConvertLookup> {
  if (config.cacheTtlMs <= 0) {
    // No single-flight without a cache: each request is a genuinely separate
    // conversion, so they queue against the semaphore instead of merging.
    return { result: await withSlot(() => fetchConvertedConfig(req)), source: 'fetch' };
  }

  const key = cacheKeyFor(req);

  if (opts.bypassCache !== true) {
    const hit = cache.get(key);
    if (hit !== undefined) return { result: hit, source: 'cache' };
  }

  const { promise, joined } = inflight.run(key, async () => {
    // The semaphore sits INSIDE the single-flight closure on purpose. Only
    // the leader runs this function, so exactly one slot is taken per
    // upstream call however many waiters attach - whereas acquiring outside
    // would have 200 joiners contend for 200 slots to make 1 request.
    const fresh = await withSlot(() => fetchConvertedConfig(req));
    cache.set(key, fresh);
    return fresh;
  });

  return { result: await promise, source: joined ? 'coalesced' : 'fetch' };
}

export function converterStats(): {
  cache: {
    enabled: boolean;
    ttlMs: number;
    entries: number;
    bytes: number;
    hits: number;
    misses: number;
    evictions: number;
    inflight: number;
  };
  concurrency: { active: number; queued: number; maxConcurrent: number; maxQueue: number };
} {
  return {
    cache: {
      enabled: config.cacheTtlMs > 0,
      ttlMs: config.cacheTtlMs,
      ...cache.stats,
      inflight: inflight.size,
    },
    concurrency: semaphore.stats,
  };
}

/**
 * Builds the ConvertRequest for a profile + its resolved sources.
 * Kept here so the route does not have to know about encoding at all.
 */
export function requestForProfile(
  profile: Profile,
  sourceUrls: string[],
  userAgent: string | undefined,
): ConvertRequest {
  return {
    target: profile.target,
    sourceUrls,
    customRuleset: profile.customRuleset,
    excludeRemarks: profile.excludeRemarks,
    udp: profile.udp,
    userAgent,
    token: config.subconverterToken || undefined,
  };
}
