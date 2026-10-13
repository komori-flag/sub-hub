import { Hono } from 'hono';
import { getProfileByKey, getTemplate, listSubscriptionsByIds } from '../db.js';
import { ConverterError, getConvertedConfig, requestForProfile } from '../services/converter.js';
import {
  appendToGroupSection,
  applyNodePrefix,
  buildPrefixPlan,
  buildSourceGroups,
  scanGroups,
  scanNodes,
} from '../services/prefix.js';
import { internalServerEnabled, internalTemplateUrl } from './internal.js';
import type { ConvertRequest } from '../services/converter.js';
import type { Profile, Subscription } from '../types.js';

export const sub = new Hono();

/** Targets whose output is a Clash config, and so has nodes with names. */
const CLASH_TARGETS = new Set(['clash', 'clashr', 'clashm', 'mihomo']);

/**
 * Points the request at the profile's locally stored template, when it has one.
 *
 * Subconverter needs a URL, so the template is served from the loopback port
 * rather than being handed over directly.
 *
 * A missing template leaves the request alone, so the profile falls back to
 * `customRuleset` - which is a config that still works, rather than a broken
 * one. The alternative, handing Subconverter an id that 404s, would have it
 * read an error page as a template.
 */
async function withLocalTemplate(req: ConvertRequest, profile: Profile): Promise<ConvertRequest> {
  if (!internalServerEnabled() || !profile.templateId) return req;

  const template = await getTemplate(profile.templateId);
  if (!template) {
    console.warn(
      `[sub] key=${profile.key} local template ${profile.templateId} is missing, ` +
        `falling back to the URL template`,
    );
    return req;
  }

  return { ...req, customRuleset: internalTemplateUrl(profile.templateId) };
}

/**
 * Rewrites node names to carry their source: `HK-01` -> `[机场甲] HK-01`.
 *
 * This needs to know which node came from which source, and Subconverter does
 * not say - it merges every source into one flat list. So each source is
 * converted on its own, with the same request parameters (the template can
 * influence node naming, so using a different shape here would produce names
 * that do not match), and the resulting name sets are mapped back onto the
 * merged config.
 *
 * That is one extra conversion per source on a cache miss, which is why this
 * is opt-in.
 *
 * Every failure path returns the config UNCHANGED. A missing prefix is a
 * cosmetic loss; a half-renamed config, where the groups still point at the
 * old names, is a broken one that no error would reveal.
 */
/**
 * The output transforms that need to know which node came from which source.
 *
 * Both are opt-in and independent: the prefix changes how nodes are labelled,
 * the groups change what a client can select, and either is useful alone. What
 * they share is the ownership analysis, which is the expensive part - each
 * source is converted separately to find out what its nodes are called.
 */
async function applyNodeTransforms(
  profile: Profile,
  sources: Subscription[],
  body: ArrayBuffer,
): Promise<ArrayBuffer> {
  if (!profile.prefixNodes && !profile.sourceGroups) return body;

  if (!CLASH_TARGETS.has(profile.target)) {
    console.warn(
      `[sub] key=${profile.key} transforms skipped: target "${profile.target}" is not a Clash config`,
    );
    return body;
  }

  const yaml = new TextDecoder().decode(body);

  // Read the shape before touching anything. Every check below is a refusal,
  // not a repair: an output style we cannot read must stop the whole rewrite
  // rather than produce a partial one.
  const nodes = scanNodes(yaml);
  if (nodes.inline) {
    console.warn(
      `[sub] key=${profile.key} prefix skipped: the proxies block is on one line ` +
        `(clash_proxies_style is probably "compact")`,
    );
    return body;
  }
  if (nodes.unreadable > 0) {
    console.warn(
      `[sub] key=${profile.key} prefix skipped: ${nodes.unreadable} node entries could not be read ` +
        `(unexpected clash_proxies_style or Subconverter output change)`,
    );
    return body;
  }

  // The groups matter more than they look. A flow-style entry keeps its node
  // references on the same line as the group, and applyNodePrefix only
  // rewrites `- <name>` lines - so renaming the nodes and not these would
  // leave every group pointing at names that no longer exist.
  const groups = scanGroups(yaml);
  if (groups.inline) {
    console.warn(
      `[sub] key=${profile.key} prefix skipped: the proxy-groups block is on one line`,
    );
    return body;
  }
  if (groups.inlineEntries > 0) {
    console.warn(
      `[sub] key=${profile.key} prefix skipped: ${groups.inlineEntries} group entries are flow style, ` +
        `so their node references cannot be rewritten (clash_proxy_groups_style should be "block")`,
    );
    return body;
  }

  const owners = new Map<string, string[]>();
  try {
    for (const source of sources) {
      const single = await getConvertedConfig(requestForProfile(profile, [source.url]));
      const scan = scanNodes(new TextDecoder().decode(single.result.body));

      // If we cannot read a single source's nodes, the merged config's
      // ownership map would be incomplete - and an incomplete map is what
      // makes buildPrefixPlan refuse anyway, just less legibly.
      if (scan.inline || scan.unreadable > 0) {
        console.warn(
          `[sub] key=${profile.key} prefix skipped: source "${source.name}" did not return readable nodes`,
        );
        return body;
      }

      for (const name of scan.names) {
        const list = owners.get(name);
        if (list) list.push(source.name);
        else owners.set(name, [source.name]);
      }
    }
  } catch (err) {
    console.warn(`[sub] key=${profile.key} prefix skipped: probing a source failed`, err);
    return body;
  }

  const plan = buildPrefixPlan(nodes.names, owners, groups.names);
  if (!plan.ok) {
    console.warn(`[sub] key=${profile.key} transforms skipped: ${plan.reason}`);
    return body;
  }

  let out = profile.prefixNodes ? applyNodePrefix(yaml, plan.mapping) : yaml;

  if (profile.sourceGroups) {
    out = addSourceGroups(out, plan.mapping, owners, groups.names, profile);
  }

  const encoded = new TextEncoder().encode(out);
  return encoded.buffer as ArrayBuffer;
}

/**
 * Adds one select group per source, listing that source's nodes.
 *
 * Only ever appends - see buildSourceGroups. A failure here leaves the config
 * as it was, which is missing groups rather than a broken file.
 */
function addSourceGroups(
  yaml: string,
  mapping: Map<string, string>,
  owners: Map<string, string[]>,
  existingGroupNames: string[],
  profile: Profile,
): string {
  const bySource = new Map<string, string[]>();
  for (const [node, renamed] of mapping) {
    const source = owners.get(node)?.[0];
    // buildPrefixPlan already guarantees exactly one owner per node.
    if (source === undefined) continue;

    // With prefixing off the groups list the node's own name; the grouping is
    // still what the operator asked for.
    const listed = profile.prefixNodes ? renamed : node;
    const list = bySource.get(source);
    if (list) list.push(listed);
    else bySource.set(source, [listed]);
  }

  const built = buildSourceGroups(bySource, existingGroupNames, {
    type: profile.sourceGroupType,
    url: profile.sourceGroupUrl,
    interval: profile.sourceGroupInterval,
    tolerance: profile.sourceGroupTolerance,
  });
  if (!built.ok) {
    console.warn(`[sub] key=${profile.key} source groups skipped: ${built.reason}`);
    return yaml;
  }

  const appended = appendToGroupSection(yaml, built.yaml);
  if (!appended.ok) {
    console.warn(`[sub] key=${profile.key} source groups skipped: ${appended.reason}`);
    return yaml;
  }

  console.log(`[sub] key=${profile.key} added ${built.names.length} source group(s)`);
  return appended.content;
}

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
      await withLocalTemplate(
        requestForProfile(
          profile,
          sources.map((s) => s.url),
        ),
        profile,
      ),
      { bypassCache },
    );

    const body = await applyNodeTransforms(profile, sources, result.body);

    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      // no-store is deliberate and does NOT contradict the server-side cache:
      // that cache is keyed on everything that can change the output and is
      // invalidated by it, whereas an intermediary or the client caching this
      // URL has no idea a profile was edited, and would keep serving the old
      // config. Reuse is managed here, not delegated downstream.
      'Cache-Control': 'no-store',
    };

    // A suggestion, not a control. This tells a client how often it may
    // re-fetch; the client's own auto-update setting always wins, so leaving
    // it out stops the suggestion rather than stopping the polling.
    if (profile.autoUpdate) {
      headers['Profile-Update-Interval'] = String(profile.updateIntervalHours);
    }
    // Forwarded only when this profile resolves to exactly ONE source.
    //
    // Subconverter does not aggregate across sources: measured against v0.9.9,
    // with two sources it returns the LAST one's header verbatim. A two-source
    // profile therefore presented one airport's quota and expiry as though they
    // described the whole subscription, with the other source invisible - a
    // number a client displays prominently and that is simply not true.
    //
    // There is no single honest figure for several non-fungible plans, so none
    // is sent; the console shows the real per-source numbers instead. Absent is
    // also the ordinary case for a plain node list with no traffic metadata,
    // so clients already handle the header being missing.
    if (sources.length === 1 && result.subscriptionUserinfo) {
      headers['Subscription-Userinfo'] = result.subscriptionUserinfo;
    }

    console.log(
      `[sub] key=${key} sources=${sources.length} upstream=${result.upstreamStatus} ` +
        `${source} ${Date.now() - started}ms`,
    );
    return c.body(body, 200, headers);
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
