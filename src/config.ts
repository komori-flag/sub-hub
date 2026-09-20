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
 */
const DEFAULT_CACHE_TTL_MS = 90_000;
let cacheTtlMs = DEFAULT_CACHE_TTL_MS;
const rawCacheTtl = process.env.CACHE_TTL_MS;
if (rawCacheTtl !== undefined && rawCacheTtl.trim() !== '') {
  const parsed = Number(rawCacheTtl);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3_600_000) {
    problems.push(`CACHE_TTL_MS must be an integer in 0..3600000 (got "${rawCacheTtl}")`);
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
  adminToken: string;
  subconverterUrl: string;
  subconverterToken: string;
  converterTimeoutMs: number;
  maxConcurrentConversions: number;
  cacheTtlMs: number;
  cacheMaxBytes: number;
  databasePath: string;
}

export const config: Config = Object.freeze({
  port,
  adminToken,
  subconverterUrl,
  subconverterToken,
  converterTimeoutMs,
  maxConcurrentConversions,
  cacheTtlMs,
  cacheMaxBytes,
  databasePath,
});
