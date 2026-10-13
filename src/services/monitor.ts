import { config } from '../config.js';
import { listSubscriptions, upsertSourceCheck } from '../db.js';
import type { SourceCheck, Subscription, UpsertSourceCheckInput } from '../types.js';
import { ConverterError, getConvertedConfig } from './converter.js';

/* ------------------------------------------------------------------ *
 * Parsing
 *
 * Both of these decode something Subconverter produces, which is the part
 * most likely to break quietly. They are pure and exported so they can be
 * tested directly rather than through a live backend.
 * ------------------------------------------------------------------ */

/**
 * Counts entries in the `proxies:` block of a Clash config.
 *
 * Walks to the `proxies:` line, counts indented `- ` entries after it, and
 * stops at the next top-level key. A `proxies: []` config therefore counts 0,
 * which is correct.
 *
 * Returns 0 rather than throwing if the shape is not recognised - but 0 is
 * treated as a failure by levelFor() below, so a format change surfaces as a
 * red source rather than as a quietly healthy one.
 */
export function countNodes(yaml: string): number {
  let inProxies = false;
  let count = 0;

  for (const line of yaml.split('\n')) {
    if (!inProxies) {
      if (/^proxies:\s*$/.test(line)) inProxies = true;
      continue;
    }
    // Back at column 0 means the next top-level key, so the block ended.
    if (line !== '' && !/^\s/.test(line)) break;
    if (/^\s+-/.test(line)) count++;
  }

  return count;
}

export interface Userinfo {
  upload: number | null;
  download: number | null;
  total: number | null;
  /** Unix seconds. */
  expire: number | null;
}

/**
 * Parses Subconverter's `Subscription-Userinfo` header, e.g.
 * `upload=171751; download=13343224; total=107374182400; expire=1794057373`.
 *
 * Missing fields come back as null rather than 0: a provider that reports no
 * quota is not the same as one reporting zero bytes left.
 */
export function parseUserinfo(header: string | null): Userinfo {
  const missing: Userinfo = { upload: null, download: null, total: null, expire: null };
  if (header === null || header.trim() === '') return missing;

  const read = (key: string): number | null => {
    const match = new RegExp(`(?:^|[;,\\s])${key}\\s*=\\s*(\\d+)`).exec(header);
    return match ? Number(match[1]) : null;
  };

  return {
    upload: read('upload'),
    download: read('download'),
    total: read('total'),
    expire: read('expire'),
  };
}

/* ------------------------------------------------------------------ *
 * Severity
 * ------------------------------------------------------------------ */

export type CheckLevel = 'ok' | 'warn' | 'error';

const EXPIRY_WARN_DAYS = 7;
const QUOTA_WARN_RATIO = 0.9;
const DAY_SECONDS = 86_400;

/**
 * How loudly a result should be reported. Pure, so the thresholds are testable
 * without waiting for a real subscription to expire.
 */
export function levelFor(check: SourceCheck, now: number = Date.now()): CheckLevel {
  if (!check.ok) return 'error';
  // A source that converts but yields nothing is broken, whatever it reports.
  if (check.nodeCount === 0) return 'error';

  const nowSeconds = Math.floor(now / 1000);
  if (check.expire !== null) {
    if (check.expire <= nowSeconds) return 'error';
    if (check.expire - nowSeconds <= EXPIRY_WARN_DAYS * DAY_SECONDS) return 'warn';
  }

  if (check.total !== null && check.total > 0) {
    const used = (check.upload ?? 0) + (check.download ?? 0);
    if (used / check.total >= QUOTA_WARN_RATIO) return 'warn';
  }

  return 'ok';
}

/**
 * A check plus its computed severity, which is what the API returns.
 *
 * The level is derived server-side on purpose: re-implementing the thresholds
 * in the console would let the two drift, and then the page would colour
 * something differently from what the log called it.
 */
export interface SourceHealth extends SourceCheck {
  level: CheckLevel;
}

export function withLevel(check: SourceCheck): SourceHealth {
  return { ...check, level: levelFor(check) };
}

/* ------------------------------------------------------------------ *
 * Checking
 * ------------------------------------------------------------------ */

/**
 * Probes one source through the same path a client request takes.
 *
 * Reusing getConvertedConfig rather than fetching directly buys three things:
 * the concurrency semaphore (a direct fetch would bypass it and let monitoring
 * saturate Subconverter), single-flight, and the Subscription-Userinfo header,
 * which is the only source of the traffic and expiry numbers.
 *
 * bypassCache because monitoring wants the numbers as they are now, not as
 * they were up to a TTL ago. It still writes to the cache - that happens
 * inside the single-flight closure and cannot be skipped - which is harmless:
 * the monitor's request shape does not match any profile's, and if one ever
 * did match, a cache hit is the correct answer anyway.
 */
export async function probeSource(sub: Subscription): Promise<UpsertSourceCheckInput> {
  const started = Date.now();

  try {
    const { result } = await getConvertedConfig(
      {
        target: 'clash',
        sourceUrls: [sub.url],
        customRuleset: null,
        excludeRemarks: null,
        udp: true,
        // No template here, so this only avoids inlining the built-in rulesets:
        // ~29 KB instead of ~547 KB, with an identical proxies block.
        expand: false,
      },
      { bypassCache: true },
    );

    return {
      sourceId: sub.id,
      ok: true,
      nodeCount: countNodes(new TextDecoder().decode(result.body)),
      ...parseUserinfo(result.subscriptionUserinfo),
      httpStatus: result.upstreamStatus,
      error: null,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      sourceId: sub.id,
      ok: false,
      nodeCount: null,
      upload: null,
      download: null,
      total: null,
      expire: null,
      httpStatus: err instanceof ConverterError ? err.status : null,
      // detail is Subconverter's own explanation, e.g. "No nodes were found!".
      // It is kept out of `message` because the short-link path sends that to
      // clients, but here it is the difference between a useful log line and
      // "responded 400".
      error: describeError(err),
      latencyMs: Date.now() - started,
    };
  }
}

function describeError(err: unknown): string {
  if (err instanceof ConverterError) {
    return err.detail ? `${err.message}: ${err.detail}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Probes a source and records the result. Never throws. */
export async function checkSource(sub: Subscription): Promise<SourceCheck> {
  return upsertSourceCheck(await probeSource(sub));
}

/** Checks every enabled source, one at a time. */
export async function checkAllSources(): Promise<SourceCheck[]> {
  const subs = await listSubscriptions();
  const enabled = subs.filter((s) => s.enabled);
  const results: SourceCheck[] = [];

  // Sequential on purpose. In parallel they would all claim conversion slots
  // at once and push real client requests into the queue behind them; the
  // whole point of a six-hour interval is that it is never in a hurry.
  for (const sub of enabled) {
    const check = await checkSource(sub);
    results.push(check);
    logCheck(sub, check);
  }

  return results;
}

function logCheck(sub: Subscription, check: SourceCheck): void {
  const level = levelFor(check);

  if (level === 'ok') {
    console.log(
      `[monitor] ${sub.name} ok - ${check.nodeCount} nodes, ${check.latencyMs}ms` +
        describeQuota(check),
    );
    return;
  }

  const line = `[monitor] ${sub.name} ${level.toUpperCase()}${describeProblem(check)}`;
  if (level === 'error') console.error(line);
  else console.warn(line);
}

function describeProblem(check: SourceCheck): string {
  if (!check.ok) return `: ${check.error ?? 'check failed'}`;
  if (check.nodeCount === 0) return ': 0 nodes';

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (check.expire !== null && check.expire <= nowSeconds) {
    return `: expired on ${new Date(check.expire * 1000).toISOString().slice(0, 10)}`;
  }
  if (check.expire !== null && check.expire - nowSeconds <= EXPIRY_WARN_DAYS * DAY_SECONDS) {
    const days = Math.ceil((check.expire - nowSeconds) / DAY_SECONDS);
    return `: expires in ${days} day(s)`;
  }
  return describeQuota(check) || ': quota almost used up';
}

function describeQuota(check: SourceCheck): string {
  if (check.total === null || check.total <= 0) return '';
  const used = (check.upload ?? 0) + (check.download ?? 0);
  const gib = (bytes: number): string => (bytes / 1024 / 1024 / 1024).toFixed(1);
  return ` [${gib(used)}/${gib(check.total)} GiB]`;
}

/* ------------------------------------------------------------------ *
 * Scheduling
 * ------------------------------------------------------------------ */

/**
 * Starts the periodic check and returns a stop function.
 *
 * Self-rescheduling setTimeout rather than setInterval: if a run ever takes
 * longer than the interval, setInterval would stack overlapping runs, while
 * this simply waits.
 */
export function startMonitor(): () => void {
  if (config.monitorIntervalMs <= 0) {
    console.log('[monitor] disabled (MONITOR_INTERVAL_MS=0)');
    return () => {};
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => {
      void (async () => {
        if (stopped) return;
        try {
          await checkAllSources();
        } catch (err) {
          // Must not escape: index.ts treats an unhandled rejection as fatal
          // and exits, so a monitor bug would take the whole service down.
          console.error('[monitor] run failed:', err);
        }
        if (!stopped) schedule(config.monitorIntervalMs);
      })();
    }, delayMs);

    // Do not hold the event loop open; the HTTP server is what keeps the
    // process alive, and shutdown should not have to wait for a timer.
    timer.unref();
  };

  console.log(
    `[monitor] enabled - first run in ${Math.round(config.monitorStartupDelayMs / 1000)}s, ` +
      `then every ${Math.round(config.monitorIntervalMs / 60_000)}min`,
  );
  schedule(config.monitorStartupDelayMs);

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}
