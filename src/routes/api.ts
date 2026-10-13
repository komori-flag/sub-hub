import { Hono } from 'hono';
import {
  deleteProfile,
  deleteRuleset,
  deleteSubscription,
  deleteTemplate,
  getProfileByKey,
  getSubscription,
  getTemplate,
  listProfiles,
  listRulesets,
  listSourceChecks,
  listSubscriptions,
  listTemplates,
  MAX_UPDATE_INTERVAL_HOURS,
  MIN_UPDATE_INTERVAL_HOURS,
  profilesUsingTemplate,
  SOURCE_GROUP_TYPES,
  upsertProfile,
  upsertRuleset,
  upsertSubscription,
  upsertTemplate,
} from '../db.js';
import { adminAuth } from '../middleware/auth.js';
import { checkAllSources, checkSource, withLevel } from '../services/monitor.js';
import type {
  UpsertProfileInput,
  UpsertRulesetInput,
  UpsertSubscriptionInput,
  UpsertTemplateInput,
} from '../types.js';

/** Templates are documents; anything near this size is not one. */
const MAX_TEMPLATE_BYTES = 1024 * 1024;

export const api = new Hono();

// Applied INSIDE the module that owns the protected routes, so it is
// impossible to re-mount `api` elsewhere and silently lose authentication.
api.use('*', adminAuth);

/* ------------------------------------------------------------------ *
 * Validation
 *
 * Hand-written rather than zod: two tables and eight endpoints do not
 * justify a dependency, and this way the 400 payload shape is fully under
 * our control. If the schema grows, zod is a drop-in at this boundary.
 * ------------------------------------------------------------------ */

interface FieldError {
  field: string;
  message: string;
}

type Validated<T> = { ok: true; value: T } | { ok: false; details: FieldError[] };

/** The short-link key is a URL path segment - restrict it at write time rather than escape it at read time. */
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = KEY_RE;

const MAX_SOURCES_PER_PROFILE = 50;

/**
 * A typo'd target would otherwise be forwarded to Subconverter, which returns
 * an error page we surface as a generic UPSTREAM_ERROR - a bad error message
 * for an obvious user mistake. Validate where a human is present (the write
 * path); stay permissive on the read path.
 */
const SUPPORTED_TARGETS = new Set([
  'auto',
  'clash',
  'clashm',
  'clashr',
  'loon',
  'mellow',
  'mihomo',
  'mixed',
  'quan',
  'quanx',
  'singbox',
  'ss',
  'ssr',
  'sssub',
  'surfboard',
  'surge',
  'trojan',
  'v2ray',
  'v2rayn',
]);

/** The API speaks camelCase but the schema says source_ids, so accept both. */
function pick(body: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (body[k] !== undefined) return body[k];
  }
  return undefined;
}

function parseBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return v === 1;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return undefined;
}

function optionalString(
  v: unknown,
  field: string,
  errors: FieldError[],
  maxLength: number,
): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    errors.push({ field, message: 'must be a string or null' });
    return undefined;
  }
  const trimmed = v.trim();
  if (trimmed === '') return null;
  if (trimmed.length > maxLength) {
    errors.push({ field, message: `must be at most ${maxLength} characters` });
    return undefined;
  }
  return trimmed;
}

function parseSubscriptionInput(body: Record<string, unknown>): Validated<UpsertSubscriptionInput> {
  const errors: FieldError[] = [];

  const id = pick(body, 'id');
  if (id !== undefined) {
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      errors.push({ field: 'id', message: 'must match /^[A-Za-z0-9_-]{1,64}$/ (or be omitted to auto-generate)' });
    }
  }

  const name = pick(body, 'name');
  if (typeof name !== 'string' || name.trim() === '') {
    errors.push({ field: 'name', message: 'is required and must be a non-empty string' });
  } else if (name.trim().length > 128) {
    errors.push({ field: 'name', message: 'must be at most 128 characters' });
  }

  const url = pick(body, 'url');
  if (typeof url !== 'string' || url.trim() === '') {
    errors.push({ field: 'url', message: 'is required and must be a non-empty string' });
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url.trim());
    } catch {
      parsed = null;
    }
    // Scheme allow-list at the write boundary: rejects file:, gopher:, etc.
    // It does NOT stop a private-range target - see the SSRF note in README.
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      errors.push({ field: 'url', message: 'must be a valid http:// or https:// URL' });
    }
  }

  const rawEnabled = pick(body, 'enabled');
  let enabled: boolean | undefined;
  if (rawEnabled !== undefined) {
    enabled = parseBoolean(rawEnabled);
    if (enabled === undefined) errors.push({ field: 'enabled', message: 'must be a boolean' });
  }

  if (errors.length > 0) return { ok: false, details: errors };

  return {
    ok: true,
    value: {
      name: (name as string).trim(),
      url: (url as string).trim(),
      ...(typeof id === 'string' ? { id } : {}),
      ...(enabled === undefined ? {} : { enabled }),
    },
  };
}

function parseProfileInput(body: Record<string, unknown>): Validated<UpsertProfileInput> {
  const errors: FieldError[] = [];

  const key = pick(body, 'key');
  if (typeof key !== 'string' || !KEY_RE.test(key.trim())) {
    errors.push({
      field: 'key',
      message: 'is required and must match /^[A-Za-z0-9_-]{1,64}$/ (it becomes the short-link path)',
    });
  }

  const target = pick(body, 'target');
  let resolvedTarget = 'clash';
  if (target !== undefined) {
    if (typeof target !== 'string' || !SUPPORTED_TARGETS.has(target.trim())) {
      errors.push({
        field: 'target',
        message: `must be one of: ${[...SUPPORTED_TARGETS].sort().join(', ')}`,
      });
    } else {
      resolvedTarget = target.trim();
    }
  }

  const rawIds = pick(body, 'sourceIds', 'source_ids');
  let sourceIds: string[] = [];
  if (!Array.isArray(rawIds)) {
    errors.push({ field: 'sourceIds', message: 'is required and must be an array of subscription ids' });
  } else if (rawIds.length === 0) {
    errors.push({ field: 'sourceIds', message: 'must contain at least one subscription id' });
  } else if (rawIds.length > MAX_SOURCES_PER_PROFILE) {
    errors.push({ field: 'sourceIds', message: `must contain at most ${MAX_SOURCES_PER_PROFILE} ids` });
  } else if (!rawIds.every((v) => typeof v === 'string' && v.trim() !== '')) {
    errors.push({ field: 'sourceIds', message: 'must contain only non-empty strings' });
  } else {
    sourceIds = [...new Set((rawIds as string[]).map((v) => v.trim()))];
  }

  const customRuleset = optionalString(
    pick(body, 'customRuleset', 'custom_ruleset'),
    'customRuleset',
    errors,
    512,
  );
  const excludeRemarks = optionalString(
    pick(body, 'excludeRemarks', 'exclude_remarks'),
    'excludeRemarks',
    errors,
    512,
  );

  const rawUdp = pick(body, 'udp');
  let udp: boolean | undefined;
  if (rawUdp !== undefined) {
    udp = parseBoolean(rawUdp);
    if (udp === undefined) errors.push({ field: 'udp', message: 'must be a boolean' });
  }

  // null is still accepted and means false, so a client written against the
  // older tri-state API keeps working rather than erroring.
  const rawExpand = pick(body, 'expand');
  let expand: boolean | undefined;
  if (rawExpand !== undefined && rawExpand !== null) {
    expand = parseBoolean(rawExpand);
    if (expand === undefined) errors.push({ field: 'expand', message: 'must be a boolean' });
  } else if (rawExpand === null) {
    expand = false;
  }

  const rawAutoUpdate = pick(body, 'autoUpdate', 'auto_update');
  let autoUpdate: boolean | undefined;
  if (rawAutoUpdate !== undefined) {
    autoUpdate = parseBoolean(rawAutoUpdate);
    if (autoUpdate === undefined) {
      errors.push({ field: 'autoUpdate', message: 'must be a boolean' });
    }
  }

  // Bounded because the value goes into a response header a client is expected
  // to honour: a nonsense interval would leave a client polling constantly, or
  // never.
  const rawInterval = pick(body, 'updateIntervalHours', 'update_interval_hours');
  let updateIntervalHours: number | undefined;
  if (rawInterval !== undefined) {
    const n = typeof rawInterval === 'string' ? Number(rawInterval) : rawInterval;
    if (
      typeof n !== 'number' ||
      !Number.isInteger(n) ||
      n < MIN_UPDATE_INTERVAL_HOURS ||
      n > MAX_UPDATE_INTERVAL_HOURS
    ) {
      errors.push({
        field: 'updateIntervalHours',
        message: `must be an integer in ${MIN_UPDATE_INTERVAL_HOURS}..${MAX_UPDATE_INTERVAL_HOURS} hours`,
      });
    } else {
      updateIntervalHours = n;
    }
  }

  const rawPrefixNodes = pick(body, 'prefixNodes', 'prefix_nodes');
  let prefixNodes: boolean | undefined;
  if (rawPrefixNodes !== undefined) {
    prefixNodes = parseBoolean(rawPrefixNodes);
    if (prefixNodes === undefined) {
      errors.push({ field: 'prefixNodes', message: 'must be a boolean' });
    }
  }

  const rawSourceGroups = pick(body, 'sourceGroups', 'source_groups');
  let sourceGroups: boolean | undefined;
  if (rawSourceGroups !== undefined) {
    sourceGroups = parseBoolean(rawSourceGroups);
    if (sourceGroups === undefined) {
      errors.push({ field: 'sourceGroups', message: 'must be a boolean' });
    }
  }

  // Only meaningful with sourceGroups on, but validated regardless: accepting
  // a nonsense type and ignoring it would hide the typo until someone
  // wondered why their group behaves like a select.
  const rawGroupType = pick(body, 'sourceGroupType', 'source_group_type');
  let sourceGroupType: string | undefined;
  if (rawGroupType !== undefined) {
    const value = typeof rawGroupType === 'string' ? rawGroupType.trim() : '';
    if (!(SOURCE_GROUP_TYPES as readonly string[]).includes(value)) {
      errors.push({
        field: 'sourceGroupType',
        message: `must be one of: ${SOURCE_GROUP_TYPES.join(', ')}`,
      });
    } else {
      sourceGroupType = value;
    }
  }

  const rawGroupUrl = pick(body, 'sourceGroupUrl', 'source_group_url');
  let sourceGroupUrl: string | null | undefined;
  if (rawGroupUrl !== undefined) {
    if (rawGroupUrl === null || (typeof rawGroupUrl === 'string' && rawGroupUrl.trim() === '')) {
      sourceGroupUrl = null;
    } else if (typeof rawGroupUrl === 'string') {
      let parsed: URL | null = null;
      try {
        parsed = new URL(rawGroupUrl.trim());
      } catch {
        parsed = null;
      }
      // This URL is probed by whichever device runs the client, so a scheme
      // Subconverter cannot use would produce groups that never resolve.
      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        errors.push({ field: 'sourceGroupUrl', message: 'must be a valid http:// or https:// URL' });
      } else {
        sourceGroupUrl = rawGroupUrl.trim();
      }
    } else {
      errors.push({ field: 'sourceGroupUrl', message: 'must be a valid http:// or https:// URL' });
    }
  }

  const rawGroupInterval = pick(body, 'sourceGroupInterval', 'source_group_interval');
  let sourceGroupInterval: number | undefined;
  if (rawGroupInterval !== undefined) {
    const n = typeof rawGroupInterval === 'string' ? Number(rawGroupInterval) : rawGroupInterval;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 10 || n > 86_400) {
      errors.push({ field: 'sourceGroupInterval', message: 'must be an integer in 10..86400 seconds' });
    } else {
      sourceGroupInterval = n;
    }
  }

  const rawGroupTolerance = pick(body, 'sourceGroupTolerance', 'source_group_tolerance');
  let sourceGroupTolerance: number | undefined;
  if (rawGroupTolerance !== undefined) {
    const n = typeof rawGroupTolerance === 'string' ? Number(rawGroupTolerance) : rawGroupTolerance;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 5000) {
      errors.push({ field: 'sourceGroupTolerance', message: 'must be an integer in 0..5000 ms' });
    } else {
      sourceGroupTolerance = n;
    }
  }

  // null and "" both clear it, so switching back to the URL template does not
  // require a separate endpoint.
  const rawTemplateId = pick(body, 'templateId', 'template_id');
  let templateId: string | null | undefined;
  if (rawTemplateId !== undefined) {
    if (rawTemplateId === null) {
      templateId = null;
    } else if (typeof rawTemplateId === 'string') {
      const trimmed = rawTemplateId.trim();
      if (trimmed === '') templateId = null;
      else if (ID_RE.test(trimmed)) templateId = trimmed;
      else errors.push({ field: 'templateId', message: 'must be a template id, or null to clear' });
    } else {
      errors.push({ field: 'templateId', message: 'must be a template id, or null to clear' });
    }
  }

  if (errors.length > 0) return { ok: false, details: errors };

  return {
    ok: true,
    value: {
      key: (key as string).trim(),
      target: resolvedTarget,
      sourceIds,
      customRuleset: customRuleset ?? null,
      excludeRemarks: excludeRemarks ?? null,
      ...(udp === undefined ? {} : { udp }),
      ...(expand === undefined ? {} : { expand }),
      ...(autoUpdate === undefined ? {} : { autoUpdate }),
      ...(updateIntervalHours === undefined ? {} : { updateIntervalHours }),
      ...(prefixNodes === undefined ? {} : { prefixNodes }),
      ...(sourceGroups === undefined ? {} : { sourceGroups }),
      ...(sourceGroupType === undefined ? {} : { sourceGroupType }),
      ...(sourceGroupUrl === undefined ? {} : { sourceGroupUrl }),
      ...(sourceGroupInterval === undefined ? {} : { sourceGroupInterval }),
      ...(sourceGroupTolerance === undefined ? {} : { sourceGroupTolerance }),
      ...(templateId === undefined ? {} : { templateId }),
    },
  };
}

function parseTemplateInput(body: Record<string, unknown>): Validated<UpsertTemplateInput> {
  const errors: FieldError[] = [];

  const id = pick(body, 'id');
  if (id !== undefined) {
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      errors.push({ field: 'id', message: 'must match /^[A-Za-z0-9_-]{1,64}$/ (or be omitted to auto-generate)' });
    }
  }

  const name = pick(body, 'name');
  if (typeof name !== 'string' || name.trim() === '') {
    errors.push({ field: 'name', message: 'is required and must be a non-empty string' });
  } else if (name.trim().length > 128) {
    errors.push({ field: 'name', message: 'must be at most 128 characters' });
  }

  const content = pick(body, 'content');
  if (typeof content !== 'string' || content.trim() === '') {
    errors.push({ field: 'content', message: 'is required and must be a non-empty string' });
  } else if (Buffer.byteLength(content, 'utf8') > MAX_TEMPLATE_BYTES) {
    errors.push({
      field: 'content',
      message: `must be at most ${MAX_TEMPLATE_BYTES} bytes`,
    });
  }

  if (errors.length > 0) return { ok: false, details: errors };

  return {
    ok: true,
    value: {
      name: (name as string).trim(),
      content: content as string,
      ...(typeof id === 'string' ? { id } : {}),
    },
  };
}

function parseRulesetInput(body: Record<string, unknown>): Validated<UpsertRulesetInput> {
  const errors: FieldError[] = [];

  const id = pick(body, 'id');
  if (id !== undefined) {
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      errors.push({ field: 'id', message: 'must match /^[A-Za-z0-9_-]{1,64}$/ (or be omitted to auto-generate)' });
    }
  }

  const name = pick(body, 'name');
  if (typeof name !== 'string' || name.trim() === '') {
    errors.push({ field: 'name', message: 'is required and must be a non-empty string' });
  } else if (name.trim().length > 128) {
    errors.push({ field: 'name', message: 'must be at most 128 characters' });
  }

  const url = pick(body, 'url');
  if (typeof url !== 'string' || url.trim() === '') {
    errors.push({ field: 'url', message: 'is required and must be a non-empty string' });
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url.trim());
    } catch {
      parsed = null;
    }
    // Same scheme check as subscription URLs: Subconverter fetches this, so a
    // file: or gopher: URL has no business being stored.
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      errors.push({ field: 'url', message: 'must be a valid http:// or https:// URL' });
    }
  }

  if (errors.length > 0) return { ok: false, details: errors };

  return {
    ok: true,
    value: {
      name: (name as string).trim(),
      url: (url as string).trim(),
      ...(typeof id === 'string' ? { id } : {}),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Body helpers
 * ------------------------------------------------------------------ */

function validationError(details: FieldError[]) {
  return {
    error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', details },
  };
}

async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<
  { ok: true; body: Record<string, unknown> } | { ok: false }
> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return { ok: false };
  }
  // A bare JSON literal (null, [], "x") is syntactically valid but never a
  // usable request body here.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false };
  return { ok: true, body: parsed as Record<string, unknown> };
}

function invalidJson() {
  return { error: { code: 'INVALID_JSON', message: 'Request body is not a valid JSON object' } };
}

/* ------------------------------------------------------------------ *
 * Source health
 *
 * Read the stored results, or trigger a check now. The periodic run happens in
 * the background (src/services/monitor.ts); these only let the console look at
 * what it found, or ask for a fresh one without waiting out the interval.
 * ------------------------------------------------------------------ */

api.get('/sources/health', async (c) =>
  c.json({ data: (await listSourceChecks()).map(withLevel) }),
);

// Enabled sources only, matching what the background run covers.
api.post('/sources/check', async (c) =>
  c.json({ data: (await checkAllSources()).map(withLevel) }),
);

// By id, so a source can still be probed while disabled - which is exactly
// when you want to know whether it has recovered.
api.post('/sources/:id/check', async (c) => {
  const sub = await getSubscription(c.req.param('id'));
  if (!sub) return c.json({ error: { code: 'NOT_FOUND', message: 'No such subscription' } }, 404);
  return c.json({ data: withLevel(await checkSource(sub)) });
});

/* ------------------------------------------------------------------ *
 * Rulesets
 * ------------------------------------------------------------------ */

api.get('/rulesets', async (c) => c.json({ data: await listRulesets() }));

api.post('/rulesets', async (c) => {
  const raw = await readJsonBody(c);
  if (!raw.ok) return c.json(invalidJson(), 400);

  const parsed = parseRulesetInput(raw.body);
  if (!parsed.ok) return c.json(validationError(parsed.details), 400);

  return c.json({ data: await upsertRuleset(parsed.value) });
});

api.delete('/rulesets/:id', async (c) => {
  const removed = await deleteRuleset(c.req.param('id'));
  if (!removed) return c.json({ error: { code: 'NOT_FOUND', message: 'No such ruleset' } }, 404);
  // Profiles copy the URL rather than referencing this row, so removing a
  // picker entry cannot affect any existing config. Nothing to cascade.
  return c.body(null, 204);
});

/* ------------------------------------------------------------------ *
 * Templates
 *
 * Locally stored .ini documents, for the case where the template cannot be
 * published - internal hostnames, tunnel endpoints. A profile references one
 * by id, unlike rulesets where the URL is copied in, so deleting one is
 * refused while anything still points at it.
 * ------------------------------------------------------------------ */

api.get('/templates', async (c) => c.json({ data: await listTemplates() }));

api.get('/templates/:id', async (c) => {
  const found = await getTemplate(c.req.param('id'));
  if (!found) return c.json({ error: { code: 'NOT_FOUND', message: 'No such template' } }, 404);
  return c.json({ data: found });
});

api.post('/templates', async (c) => {
  const raw = await readJsonBody(c);
  if (!raw.ok) return c.json(invalidJson(), 400);

  const parsed = parseTemplateInput(raw.body);
  if (!parsed.ok) return c.json(validationError(parsed.details), 400);

  return c.json({ data: await upsertTemplate(parsed.value) });
});

api.delete('/templates/:id', async (c) => {
  const id = c.req.param('id');

  // Refused rather than cascaded. Profiles here hold an id, not a copy, so
  // deleting would leave them pointing at nothing - and silently switching
  // them to their fallback template would change what those short links serve
  // without anyone asking for it.
  const usedBy = await profilesUsingTemplate(id);
  if (usedBy.length > 0) {
    return c.json(
      {
        error: {
          code: 'TEMPLATE_IN_USE',
          message: `Still used by ${usedBy.length} profile(s): ${usedBy.join(', ')}`,
          details: usedBy,
        },
      },
      409,
    );
  }

  const removed = await deleteTemplate(id);
  if (!removed) return c.json({ error: { code: 'NOT_FOUND', message: 'No such template' } }, 404);
  return c.body(null, 204);
});

/* ------------------------------------------------------------------ *
 * Subscriptions
 * ------------------------------------------------------------------ */

api.get('/subscriptions', async (c) => c.json({ data: await listSubscriptions() }));

api.get('/subscriptions/:id', async (c) => {
  const found = await getSubscription(c.req.param('id'));
  if (!found) return c.json({ error: { code: 'NOT_FOUND', message: 'No such subscription' } }, 404);
  return c.json({ data: found });
});

api.post('/subscriptions', async (c) => {
  const raw = await readJsonBody(c);
  if (!raw.ok) return c.json(invalidJson(), 400);

  const parsed = parseSubscriptionInput(raw.body);
  if (!parsed.ok) return c.json(validationError(parsed.details), 400);

  return c.json({ data: await upsertSubscription(parsed.value) });
});

api.delete('/subscriptions/:id', async (c) => {
  const removed = await deleteSubscription(c.req.param('id'));
  if (!removed) return c.json({ error: { code: 'NOT_FOUND', message: 'No such subscription' } }, 404);
  return c.body(null, 204);
});

/* ------------------------------------------------------------------ *
 * Profiles
 * ------------------------------------------------------------------ */

api.get('/profiles', async (c) => c.json({ data: await listProfiles() }));

api.get('/profiles/:key', async (c) => {
  const found = await getProfileByKey(c.req.param('key'));
  if (!found) return c.json({ error: { code: 'NOT_FOUND', message: 'No such profile' } }, 404);
  return c.json({ data: found });
});

api.post('/profiles', async (c) => {
  const raw = await readJsonBody(c);
  if (!raw.ok) return c.json(invalidJson(), 400);

  const parsed = parseProfileInput(raw.body);
  if (!parsed.ok) return c.json(validationError(parsed.details), 400);

  const saved = await upsertProfile(parsed.value);

  // Accepted, not rejected: creating the profile before its sources is a
  // legitimate order of operations. But this turns the single most common
  // misconfiguration into an immediate, visible signal instead of a mystery
  // 502 from /s/:key an hour later.
  // Warnings, not rejections: creating a profile before its sources or its
  // template exist is a legitimate order of operations. But both are the most
  // likely causes of a confusing short link later, so they are surfaced now.
  const known = await listSubscriptions();
  const knownIds = new Set(known.map((s) => s.id));
  const unknownSources = parsed.value.sourceIds.filter((id) => !knownIds.has(id));

  const warnings: string[] = [];
  if (unknownSources.length > 0) {
    warnings.push(`unknown source ids (ignored at request time): ${unknownSources.join(', ')}`);
  }
  if (parsed.value.templateId && !(await getTemplate(parsed.value.templateId))) {
    warnings.push(
      `local template '${parsed.value.templateId}' does not exist ` +
        `(this short link will fall back to the URL template, if it has one)`,
    );
  }

  return c.json(warnings.length > 0 ? { data: saved, warnings } : { data: saved });
});

api.delete('/profiles/:key', async (c) => {
  const removed = await deleteProfile(c.req.param('key'));
  if (!removed) return c.json({ error: { code: 'NOT_FOUND', message: 'No such profile' } }, 404);
  return c.body(null, 204);
});
