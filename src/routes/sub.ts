import { Hono } from 'hono';
import { getProfileByKey, listSubscriptionsByIds } from '../db.js';
import { ConverterError, getConvertedConfig, requestForProfile } from '../services/converter.js';

export const sub = new Hono();

/**
 * PUBLIC. No auth by design - this is the endpoint you hand to Clash.
 *
 * Registered with its full path (rather than mounted at a prefix) so a reader
 * of this file never has to reconstruct the URL from a mount point.
 */
sub.get('/s/:key', async (c) => {
  const key = c.req.param('key');
  const started = Date.now();

  const profile = await getProfileByKey(key);
  if (!profile) {
    return c.text(`# NOT_FOUND: no profile for key '${key}'`, 404);
  }

  if (!profile.sourceIdsValid) {
    console.warn(`[sub] key=${key} malformed source_ids JSON`);
    return c.text(`# INVALID_SOURCE_CONFIG: profile '${key}' has an unreadable source list`, 502);
  }

  if (profile.sourceIds.length === 0) {
    return c.text(`# NO_SOURCES: profile '${key}' has no sources configured`, 502);
  }

  const sources = await listSubscriptionsByIds(profile.sourceIds, { enabledOnly: true });
  if (sources.length === 0) {
    // Deliberately not "serve an empty config": Subconverter would return a
    // syntactically valid but EMPTY config with HTTP 200, silently blanking
    // the user's client. Fail loudly at the boundary instead.
    return c.text(`# NO_SOURCES: profile '${key}' has no enabled sources`, 502);
  }

  try {
    // ?refresh=1 forces a fresh conversion, ignoring any cached copy. Useful
    // when you have changed something upstream and want to see it now rather
    // than waiting out the TTL. Editing a profile or a source does not need
    // this - that changes the cache key and misses naturally.
    const bypassCache = c.req.query('refresh') === '1';

    const { result, source } = await getConvertedConfig(
      requestForProfile(
        profile,
        sources.map((s) => s.url),
        c.req.header('user-agent'),
      ),
      { bypassCache },
    );

    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Profile-Update-Interval': '24',
      // no-store is deliberate and does NOT contradict the server-side cache:
      // that cache is keyed on everything that can change the output and is
      // invalidated by it, whereas an intermediary or the client caching this
      // URL has no idea a profile was edited, and would keep serving the old
      // config. Reuse is managed here, not delegated downstream.
      'Cache-Control': 'no-store',
    };
    // Only present when an upstream source actually reported traffic info.
    // A plain node list has none, so a missing header is normal, not a bug.
    if (result.subscriptionUserinfo) {
      headers['Subscription-Userinfo'] = result.subscriptionUserinfo;
    }

    console.log(
      `[sub] key=${key} sources=${sources.length} upstream=${result.upstreamStatus} ` +
        `${source} ${Date.now() - started}ms`,
    );
    return c.body(result.body, 200, headers);
  } catch (err) {
    if (err instanceof ConverterError) {
      if (err.code !== 'CLIENT_ABORTED') {
        console.warn(`[sub] key=${key} code=${err.code} msg=${err.message} ${Date.now() - started}ms`);
      }
      // A leading '#' makes this a YAML comment, so a client that mis-parses a
      // failed fetch as a config sees a comment rather than a syntax error,
      // and a human reading a captured body immediately knows what happened.
      return c.text(`# ${err.code}: ${err.message}`, err.status);
    }
    throw err; // -> app.onError -> generic 500, no stack on the wire
  }
});
