import { isAbsolute, resolve } from 'node:path';

/* ------------------------------------------------------------------ *
 * Boot configuration.
 *
 * This module is deliberately side-effecting and is imported FIRST by
 * index.ts. That ordering is load-bearing, not stylistic: ES module imports
 * are hoisted and evaluated depth-first, so if db.ts were reached before
 * this ran, the database file would already be open by the time we decided
 * the configuration was invalid - meaning "refusing to start" would still
 * have created data/sub.db. `process.exit(1)` here guarantees a bad config
 * has zero side effects.
 * ------------------------------------------------------------------ */

// Node's own .env loader - no dotenv dependency. Throws when the file is
// absent, which is the normal case in Docker where compose supplies the env.
try {
  process.loadEnvFile();
} catch {
  /* no .env file: fine */
}

const problems: string[] = [];

/* ---- HOST ----
 * The interface to bind. Defaults to 0.0.0.0 (all interfaces), which is what
 * a container needs - the port mapping only works if the process is not
 * listening on loopback.
 *
 * For a deployment that is exposed through a tunnel or reverse proxy rather
 * than a published port, set HOST=127.0.0.1: nothing outside the machine then
 * reaches /admin or /api/* at all, instead of relying on the bearer token
 * alone. This matters most when running from source, where there is no
 * compose file to express the binding.
 *
 * Not validated here: an unbindable address fails at listen() with
 * EADDRNOTAVAIL, which names the offending value clearly enough.
 */
const host = (process.env.HOST ?? '').trim() || '0.0.0.0';

/* ---- Node version ---- *
 * Checked here, and reported as a normal problem, because this module is the
 * first thing evaluated - which means the message gets out BEFORE anything
 * imports better-sqlite3.
 *
 * That ordering is the whole point. better-sqlite3@13 needs a Node-API
 * version Node 20 does not provide, and the resulting failure is a native
 * ACCESS_VIOLATION with NO output at all: not an exception, not a stack, not
 * even a blank line. `node dist/index.js` on Node 20 simply exits, having
 * printed nothing, so the compiled-JS output is NOT portable to Node 20
 * either - the native binding is the blocker, not TypeScript.
 *
 * `engines` + .npmrc engine-strict catch this at install time, but they do
 * nothing for someone running an already-installed tree, or a copied
 * node_modules, or a prebuilt image. This is the check that catches those.
 */
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
  problems.push(
    `Node >= 22 is required, but this is ${process.versions.node}. ` +
      `better-sqlite3 crashes natively below 22 - switch with \`nvm use 22\`.`,
  );
}

/* ---- PORT ---- */
const rawPort = process.env.PORT ?? '3000';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  problems.push(`PORT must be an integer in 1..65535 (got "${rawPort}")`);
}

/* ---- ADMIN_TOKEN ----
 * Trimmed so a token pasted with a trailing space, or a CRLF line ending
 * written by a Windows editor into .env, works rather than producing a
 * mystifying "the correct token was rejected" 401.
 */
const adminToken = (process.env.ADMIN_TOKEN ?? '').trim();
if (adminToken === '') {
  problems.push('ADMIN_TOKEN is not set. Generate one with:  openssl rand -hex 32');
} else if (adminToken.length < 16) {
  problems.push(`ADMIN_TOKEN is too short (${adminToken.length} chars); use at least 16`);
}

/* ---- SUBCONVERTER_URL ---- */
const subconverterUrl = (process.env.SUBCONVERTER_URL?.trim() || 'http://subconverter:25500').replace(
  /\/+$/,
  '',
);
try {
  new URL(subconverterUrl);
} catch {
  problems.push(`SUBCONVERTER_URL is not a valid URL (got "${process.env.SUBCONVERTER_URL}")`);
}

/* ---- SUBCONVERTER_TOKEN ----
 * Sent as `&token=` on every /sub request. Needed when the backend runs with
 * api_mode=true / api_access_token set (Docker: API_MODE / API_TOKEN).
 *
 * Optional because it is defence in depth, not the primary control: when both
 * services share a compose network and subconverter publishes no ports, it is
 * already unreachable from outside. This is the layer that still holds if the
 * port ever gets published by accident.
 */
const subconverterToken = (process.env.SUBCONVERTER_TOKEN ?? '').trim();

/* ---- SUBCONVERTER_UA ----
 * The User-Agent sub-hub sends to Subconverter.
 *
 * FIXED rather than forwarded from the client. Per-client forwarding meant the
 * same short link could produce different documents depending on who asked,
 * which is exactly why the UA used to be part of the cache key. A constant UA
 * makes one profile mean one config.
 *
 * It also STABILISES `target=auto`, which was quietly broken. Subconverter
 * resolves `auto` by inspecting the REQUESTING User-Agent and does not degrade
 * gracefully: measured against v0.9.9, `auto` with an unrecognised UA returns
 * "Invalid target!" - a hard failure the client sees as a 502. Since we used
 * to forward whatever the client sent, any client Subconverter did not
 * recognise broke every `auto` profile. Not hypothetical: a plain
 * "SomeRandomThing/1.0" triggered it.
 *
 * The trade-off: a Surge client can no longer get Surge output through an
 * `auto` profile - `auto` now always means clash. Give such a client its own
 * profile with an explicit target, which is clearer anyway.
 *
 * MEASURED, and it overturns an earlier claim in this comment: this UA also
 * decides what your PROVIDERS return, not just how `auto` resolves. Against
 * this deployment's airport, the identical subscription URL returned:
 *
 *     (no UA / curl default)   -> 400 "No nodes were found!"
 *     SomeRandomThing/1.0      -> 400 "No nodes were found!"
 *     mihomo/1.18.0            -> 400 "No nodes were found!"
 *     clash-verge/v2.5.7       -> 200, ~547 KB of nodes
 *
 * So a UA the provider does not recognise is not cosmetic - it makes every
 * subscription fail, and the client only sees a generic 502. If a subscription
 * suddenly starts returning "No nodes were found!", suspect this value before
 * anything else. The mechanism (whether Subconverter forwards this UA on its
 * outbound fetch, or something else) was not established; the effect was
 * reproduced directly against the backend.
 */
const subconverterUserAgent = (process.env.SUBCONVERTER_UA ?? '').trim() || 'clash-verge/v2.5.7';

/* ---- CONVERTER_TIMEOUT_MS ----
 * Covers the WHOLE conversion: fetching every source (which may itself be
 * slow, geo-blocked or retrying) + parsing + rendering. 5s is too aggressive
 * for a six-source profile; 60s makes a hung upstream look like a hung app.
 */
const DEFAULT_TIMEOUT_MS = 20_000;
let converterTimeoutMs = DEFAULT_TIMEOUT_MS;
const rawTimeout = process.env.CONVERTER_TIMEOUT_MS;
if (rawTimeout !== undefined && rawTimeout.trim() !== '') {
  const parsed = Number(rawTimeout);
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 120_000) {
    problems.push(`CONVERTER_TIMEOUT_MS must be an integer in 1000..120000 (got "${rawTimeout}")`);
  } else {
    converterTimeoutMs = parsed;
  }
}

/* ---- MAX_CONCURRENT_CONVERSIONS ----
 * Bounds how many conversions run at once. Each one makes Subconverter fan out
 * to every source in the profile, so this is the knob that protects both the
 * subconverter container's CPU and your providers' rate limits.
 *
 * The wait queue and its timeout are derived from this rather than exposed
 * separately: queue = 8x this, and a waiter gives up after CONVERTER_TIMEOUT_MS
 * rather than queueing indefinitely.
 */
const DEFAULT_MAX_CONCURRENT = 8;
let maxConcurrentConversions = DEFAULT_MAX_CONCURRENT;
const rawMaxConcurrent = process.env.MAX_CONCURRENT_CONVERSIONS;
if (rawMaxConcurrent !== undefined && rawMaxConcurrent.trim() !== '') {
  const parsed = Number(rawMaxConcurrent);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 64) {
    problems.push(`MAX_CONCURRENT_CONVERSIONS must be an integer in 1..64 (got "${rawMaxConcurrent}")`);
  } else {
    maxConcurrentConversions = parsed;
  }
}

/* ---- CACHE_TTL_MS ----
 * 0 disables caching entirely, which is the escape hatch if you would rather
 * have a fresh conversion on every single request.
 *
 * Safe to raise a long way, which is not obvious: the cache key is a hash of
 * every input that can change the output, so editing a profile or a source
 * produces a different key and bypasses the entry immediately. The only thing
 * a long TTL makes stale is the upstream content itself - which is exactly the
 * dial this is. Raising it from the 90s default to a few hours is the cheapest
 * way to stop N clients hitting the providers N times.
 *
 * Two things lag with it: node lists change upstream, and the
 * Subscription-Userinfo quota a client displays. `?refresh=1` forces a fresh
 * conversion. Monitoring is unaffected - it passes bypassCache.
 */
const DEFAULT_CACHE_TTL_MS = 90_000;
let cacheTtlMs = DEFAULT_CACHE_TTL_MS;
const rawCacheTtl = process.env.CACHE_TTL_MS;
if (rawCacheTtl !== undefined && rawCacheTtl.trim() !== '') {
  const parsed = Number(rawCacheTtl);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 86_400_000) {
    problems.push(`CACHE_TTL_MS must be an integer in 0..86400000 (got "${rawCacheTtl}")`);
  } else {
    cacheTtlMs = parsed;
  }
}

/* ---- CACHE_MAX_BYTES ----
 * Caching config bodies means holding them in memory, so this is the bound
 * that keeps that from becoming the thing that OOMs the container. Real
 * configs run 100 KiB - 2 MiB, so 64 MiB is several dozen entries.
 */
const DEFAULT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
let cacheMaxBytes = DEFAULT_CACHE_MAX_BYTES;
const rawCacheBytes = process.env.CACHE_MAX_BYTES;
if (rawCacheBytes !== undefined && rawCacheBytes.trim() !== '') {
  const parsed = Number(rawCacheBytes);
  if (!Number.isInteger(parsed) || parsed < 1024 * 1024 || parsed > 1024 * 1024 * 1024) {
    problems.push(`CACHE_MAX_BYTES must be an integer in 1048576..1073741824 (got "${rawCacheBytes}")`);
  } else {
    cacheMaxBytes = parsed;
  }
}

/* ---- MONITOR_INTERVAL_MS ----
 * How often each enabled subscription source is probed. 0 disables monitoring
 * entirely.
 *
 * Six hours is deliberately unhurried: traffic counters and expiry dates move
 * slowly, and every check costs one Subconverter conversion plus one request
 * to the provider. It is not free, just cheap.
 */
const DEFAULT_MONITOR_INTERVAL_MS = 6 * 60 * 60 * 1000;
let monitorIntervalMs = DEFAULT_MONITOR_INTERVAL_MS;
const rawMonitorInterval = process.env.MONITOR_INTERVAL_MS;
if (rawMonitorInterval !== undefined && rawMonitorInterval.trim() !== '') {
  const parsed = Number(rawMonitorInterval);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 604_800_000) {
    problems.push(`MONITOR_INTERVAL_MS must be an integer in 0..604800000 (got "${rawMonitorInterval}")`);
  } else {
    monitorIntervalMs = parsed;
  }
}

/* ---- MONITOR_STARTUP_DELAY_MS ----
 * Grace period before the first run, so monitoring does not compete for
 * conversion slots with whatever traffic arrives at boot.
 */
const DEFAULT_MONITOR_STARTUP_DELAY_MS = 60_000;
let monitorStartupDelayMs = DEFAULT_MONITOR_STARTUP_DELAY_MS;
const rawMonitorDelay = process.env.MONITOR_STARTUP_DELAY_MS;
if (rawMonitorDelay !== undefined && rawMonitorDelay.trim() !== '') {
  const parsed = Number(rawMonitorDelay);
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 3_600_000) {
    problems.push(
      `MONITOR_STARTUP_DELAY_MS must be an integer in 1000..3600000 (got "${rawMonitorDelay}")`,
    );
  } else {
    monitorStartupDelayMs = parsed;
  }
}

/* ---- INTERNAL_PORT ----
 * Serves derived templates to Subconverter on loopback. 0 disables it.
 *
 * Subconverter takes exactly ONE `config=` and ignores repeats and pipes
 * (measured), so a template that has to carry generated groups cannot be
 * assembled by combining two files - it has to be served as one. That is what
 * this port exists for.
 *
 * The bind address is deliberately NOT configurable: it is always 127.0.0.1.
 * The endpoint has no authentication, because Subconverter cannot send any, so
 * loopback is the entire access control. A settable host would be a one-line
 * mistake away from publishing subscription metadata.
 */
const DEFAULT_INTERNAL_PORT = 0;
let internalPort = DEFAULT_INTERNAL_PORT;
const rawInternalPort = process.env.INTERNAL_PORT;
if (rawInternalPort !== undefined && rawInternalPort.trim() !== '') {
  const parsed = Number(rawInternalPort);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    problems.push(`INTERNAL_PORT must be an integer in 0..65535 (got "${rawInternalPort}")`);
  } else {
    internalPort = parsed;
  }
}

/* ---- DATABASE_PATH ---- */
const rawDbPath = process.env.DATABASE_PATH?.trim() || './data/sub.db';
const databasePath =
  rawDbPath === ':memory:' ? rawDbPath : isAbsolute(rawDbPath) ? rawDbPath : resolve(process.cwd(), rawDbPath);

if (problems.length > 0) {
  console.error('[fatal] refusing to start:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

export interface Config {
  port: number;
  host: string;
  adminToken: string;
  subconverterUrl: string;
  subconverterToken: string;
  subconverterUserAgent: string;
  converterTimeoutMs: number;
  maxConcurrentConversions: number;
  cacheTtlMs: number;
  cacheMaxBytes: number;
  monitorIntervalMs: number;
  monitorStartupDelayMs: number;
  internalPort: number;
  databasePath: string;
}

export const config: Config = Object.freeze({
  port,
  host,
  adminToken,
  subconverterUrl,
  subconverterToken,
  subconverterUserAgent,
  converterTimeoutMs,
  maxConcurrentConversions,
  cacheTtlMs,
  cacheMaxBytes,
  monitorIntervalMs,
  monitorStartupDelayMs,
  internalPort,
  databasePath,
});
