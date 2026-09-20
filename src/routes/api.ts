import { Hono } from 'hono';
import {
  deleteProfile,
  deleteSubscription,
  getProfileByKey,
  getSubscription,
  listProfiles,
  listSubscriptions,
  upsertProfile,
  upsertSubscription,
} from '../db.js';
import { adminAuth } from '../middleware/auth.js';
import type { UpsertProfileInput, UpsertSubscriptionInput } from '../types.js';

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
  const known = await listSubscriptions();
  const knownIds = new Set(known.map((s) => s.id));
  const unknown = parsed.value.sourceIds.filter((id) => !knownIds.has(id));

  return c.json(
    unknown.length > 0
      ? { data: saved, warnings: [`unknown source ids (ignored at request time): ${unknown.join(', ')}`] }
      : { data: saved },
  );
});

api.delete('/profiles/:key', async (c) => {
  const removed = await deleteProfile(c.req.param('key'));
  if (!removed) return c.json({ error: { code: 'NOT_FOUND', message: 'No such profile' } }, 404);
  return c.body(null, 204);
});
