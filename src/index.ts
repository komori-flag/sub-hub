// config.js MUST be first. It validates the environment and exits on a bad
// configuration, and because ES module imports are hoisted and evaluated
// depth-first, importing it here means that check runs before db.js opens
// the database file. Without it, "refusing to start" would still have
// created data/sub.db as a side effect.
import { config } from './config.js';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { closeDb, pingDb } from './db.js';
import { admin } from './routes/admin.js';
import { api } from './routes/api.js';
import { sub } from './routes/sub.js';
import { ConverterError, converterStats } from './services/converter.js';

/* ---------- app assembly ---------- */

const app = new Hono();

app.use('*', logger());
// CSP is off by default in Hono's secureHeaders, which matters here because
// /admin is an inline-script page; enabling it would need a nonce threaded
// through the template.
app.use('*', secureHeaders());

app.route('/api', api); // the auth middleware is applied inside api.ts
app.route('/', sub); // GET /s/:key  - public
app.route('/', admin); // GET /admin    - public shell, protected API

app.get('/', (c) =>
  c.json({
    service: 'sub-hub',
    endpoints: { admin: '/admin', health: '/health', ready: '/health/ready', short: '/s/:key' },
  }),
);

/* ---------- health ---------- */

// Liveness: no dependencies, always 200 while the process can serve. This is
// what the Docker HEALTHCHECK probes - a Subconverter outage must never mark
// the app unhealthy and trigger a restart loop.
app.get('/health', (c) => c.json({ status: 'ok', uptime: Math.round(process.uptime()) }));

// Readiness: actually touches the DB. Reports the configured Subconverter
// without failing on it - the app is intentionally functional-but-degraded
// when Subconverter is down.
app.get('/health/ready', async (c) => {
  const dbOk = await pingDb();
  return c.json(
    {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      subconverter: config.subconverterUrl,
      // Exposed here so you can tell whether caching is actually working,
      // rather than guessing from how busy the subconverter container looks.
      // `concurrency.active` sitting at maxConcurrent with a growing queue is
      // the signal that Subconverter has become the bottleneck.
      ...converterStats(),
    },
    dbOk ? 200 : 503,
  );
});

/* ---------- errors ---------- */

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));

app.onError((err, c) => {
  const isApi = c.req.path === '/api' || c.req.path.startsWith('/api/');

  if (err instanceof ConverterError && err.code !== 'CLIENT_ABORTED') {
    console.warn(`[error] ${c.req.method} ${c.req.path} ${err.code}: ${err.message}`);
    return c.text(`# ${err.code}: ${err.message}`, err.status);
  }

  if (err instanceof HTTPException) {
    const res = err.getResponse();
    return isApi ? c.json({ error: { code: 'HTTP_ERROR', message: err.message } }, err.status) : res;
  }

  // Log everything server-side; expose NOTHING client-side. No err.message,
  // no err.stack, and no driver text - a better-sqlite3 error can contain the
  // SQL statement and its bound values.
  console.error(`[error] ${c.req.method} ${c.req.path}`, err);

  return isApi
    ? c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } }, 500)
    : c.text('# INTERNAL_ERROR: something went wrong', 500);
});

/* ---------- listen + graceful shutdown ---------- */

// hostname is explicit rather than relying on the default: this single value
// decides whether the container is reachable at all, and "works locally, dead
// in compose" is exactly what a wrong default here looks like.
const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(
    `[boot] sub-hub listening on http://0.0.0.0:${info.port}\n` +
      `[boot] db=${config.databasePath}\n` +
      `[boot] subconverter=${config.subconverterUrl} timeout=${config.converterTimeoutMs}ms\n` +
      `[boot] cache=${config.cacheTtlMs > 0 ? `${config.cacheTtlMs}ms / ${Math.round(config.cacheMaxBytes / 1024 / 1024)}MiB` : 'disabled'}` +
      ` maxConcurrent=${config.maxConcurrentConversions}\n` +
      `[boot] admin token: configured (${config.adminToken.length} chars)`,
  );
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received`);

    // Don't hang forever on a stuck connection.
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();

    server.close(() => {
      closeDb()
        .catch((e) => console.error('[shutdown] db close failed', e))
        .finally(() => process.exit(0));
    });
  });
}

// A wedged process is worse than a clean restart: hand it back to the
// container's restart policy rather than limping along in an unknown state.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception', err);
  process.exit(1);
});
