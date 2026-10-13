import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import SQLite from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { config } from './config.js';
import type {
  Database,
  Profile,
  ProfileRow,
  Ruleset,
  RulesetRow,
  SourceCheck,
  SourceCheckRow,
  Subscription,
  SubscriptionRow,
  Template,
  TemplateRow,
  UpsertProfileInput,
  UpsertRulesetInput,
  UpsertSourceCheckInput,
  UpsertSubscriptionInput,
  UpsertTemplateInput,
} from './types.js';

/* ------------------------------------------------------------------ *
 * Schema
 *
 * Applied on boot with `CREATE TABLE IF NOT EXISTS` rather than through
 * Kysely's migrator. Two fixed tables do not justify a migration table
 * pair, a filesystem provider and an ordering model - and `IF NOT EXISTS`
 * means a fresh Docker volume self-initialises with zero extra steps.
 *
 * The honest caveat: IF NOT EXISTS never UPGRADES an existing table. When
 * this schema changes, add a `PRAGMA user_version` check here and run
 * numbered ALTERs, or adopt kysely/migration at that point.
 * ------------------------------------------------------------------ */

/**
 * The advertised update interval, in hours.
 *
 * 24 because that is what the short link sent unconditionally before this
 * became a per-profile setting - existing profiles must keep behaving exactly
 * as they did.
 */
export const DEFAULT_UPDATE_INTERVAL_HOURS = 24;
export const MIN_UPDATE_INTERVAL_HOURS = 1;
/** A week. Past that, turning the suggestion off is the clearer statement. */
export const MAX_UPDATE_INTERVAL_HOURS = 168;

/**
 * Group types Subconverter understands for a generated group.
 *
 * `select` is the default because it is the only one that never surprises: it
 * just lists the nodes and lets a person choose. The testing types pick for
 * them, which is what makes a `fallback` across airports work but also means
 * the config depends on the probe URL being reachable.
 */
export const SOURCE_GROUP_TYPES = ['select', 'url-test', 'load-balance', 'fallback'] as const;
export const DEFAULT_SOURCE_GROUP_TYPE = 'select';

/** Reachable from the usual places, and small. */
export const DEFAULT_SOURCE_GROUP_URL = 'http://www.google.com/generate_204';
export const DEFAULT_SOURCE_GROUP_INTERVAL = 300;
export const DEFAULT_SOURCE_GROUP_TOLERANCE = 50;

const DDL = `
CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS profiles (
    key TEXT PRIMARY KEY,
    target TEXT DEFAULT 'clash',
    source_ids TEXT NOT NULL,
    custom_ruleset TEXT,
    exclude_remarks TEXT,
    udp INTEGER DEFAULT 1,
    expand INTEGER NOT NULL DEFAULT 0,
    auto_update INTEGER NOT NULL DEFAULT 1,
    update_interval_hours INTEGER NOT NULL DEFAULT ${DEFAULT_UPDATE_INTERVAL_HOURS},
    prefix_nodes INTEGER NOT NULL DEFAULT 0,
    source_groups INTEGER NOT NULL DEFAULT 0,
    source_group_type TEXT NOT NULL DEFAULT '${DEFAULT_SOURCE_GROUP_TYPE}',
    source_group_url TEXT,
    source_group_interval INTEGER NOT NULL DEFAULT ${DEFAULT_SOURCE_GROUP_INTERVAL},
    source_group_tolerance INTEGER NOT NULL DEFAULT ${DEFAULT_SOURCE_GROUP_TOLERANCE},
    template_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rulesets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS source_checks (
    source_id   TEXT PRIMARY KEY,
    checked_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    ok          INTEGER NOT NULL DEFAULT 0,
    node_count  INTEGER,
    upload      INTEGER,
    download    INTEGER,
    total       INTEGER,
    expire      INTEGER,
    http_status INTEGER,
    error       TEXT,
    latency_ms  INTEGER
);

CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

// config.ts has already validated the environment by the time this runs -
// it is imported (and therefore evaluated) first, and it exits the process
// on a bad configuration. So reaching this line means the config is usable.
const dbPath = config.databasePath;

// Create the parent directory up front. Without this, a fresh deployment
// fails with SQLITE_CANTOPEN on the very first write, which reads like a
// permissions problem and sends you looking in the wrong place.
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new SQLite(dbPath);

sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

// `exec` runs multiple statements; `prepare` only accepts one.
sqlite.exec(DDL);

/* ------------------------------------------------------------------ *
 * Migrations
 *
 * `CREATE TABLE IF NOT EXISTS` creates a missing table but never adds a
 * column to an existing one, so every column added after the first release
 * needs an explicit step here or existing installs silently keep the old
 * shape and fail at query time.
 *
 * Checking for the column rather than tracking a PRAGMA user_version means
 * these are idempotent for free: a fresh database already has the column
 * (the DDL above defines it), so the step is a no-op there, while an existing
 * database gets the ALTER. If this ever grows past a couple of steps, switch
 * to user_version with numbered migrations - the column check stops being
 * self-describing once steps start depending on each other.
 * ------------------------------------------------------------------ */

export type SqliteHandle = InstanceType<typeof SQLite>;

export function hasColumn(sqlite: SqliteHandle, table: string, column: string): boolean {
  const columns = sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

// Takes the handle explicitly rather than closing over the module instance so
// the migration can be tested against a throwaway database - this is the one
// piece of code that runs against a live database holding real data.
export function ensureColumn(
  sqlite: SqliteHandle,
  table: string,
  column: string,
  definition: string,
): void {
  if (hasColumn(sqlite, table, column)) return;
  // ALTER TABLE ADD COLUMN cannot add a NOT NULL column without a default, so
  // added columns are nullable. That is also what we want here: NULL and
  // "explicitly false" are different states.
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Every schema step, in one place.
 *
 * Exported and taking the handle explicitly so it can be tested against a
 * throwaway database built with an older schema. This is the one piece of code
 * that runs against a live database holding real data, so "it should be fine"
 * is not good enough for it.
 */
export function runMigrations(sqlite: SqliteHandle): void {
  // v1: profiles.expand.
  //
  // v2: expand is no longer tri-state. NULL used to mean "let Subconverter
  // decide", which resolves to `true` - inline every ruleset. That turned out
  // to be the wrong default in both directions: with a ruleset template it
  // made a 19 KB config 5.2 MB, and without one 29 KB became 547 KB. Absent
  // now means false.
  //
  // The column stays nullable on databases that already had it, because SQLite
  // cannot tighten that without rebuilding the table. Rather than rebuild a
  // table holding real data, NULL is normalised on every boot - idempotent, so
  // it also self-heals a row written by an older build.
  ensureColumn(sqlite, 'profiles', 'expand', 'INTEGER NOT NULL DEFAULT 0');
  sqlite.exec('UPDATE profiles SET expand = 0 WHERE expand IS NULL');

  // v3: per-profile auto-update suggestion. Both defaults reproduce exactly
  // what the short link did before (always sent Profile-Update-Interval: 24),
  // so an existing profile's behaviour is unchanged and no normalisation pass
  // is needed - adding a NOT NULL column WITH a default backfills every
  // existing row in one step.
  ensureColumn(sqlite, 'profiles', 'auto_update', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(
    sqlite,
    'profiles',
    'update_interval_hours',
    `INTEGER NOT NULL DEFAULT ${DEFAULT_UPDATE_INTERVAL_HOURS}`,
  );

  // v4: opt-in node name prefixes. Defaults to 0, so nothing changes for an
  // existing profile - and it must stay opt-in, because turning it on costs
  // extra conversions on every cache miss.
  ensureColumn(sqlite, 'profiles', 'prefix_nodes', 'INTEGER NOT NULL DEFAULT 0');

  // v5: locally stored templates. Nullable with no default, because NULL
  // genuinely means "no local template" - the profile then falls back to
  // custom_ruleset, which is a different thing from an empty template.
  ensureColumn(sqlite, 'profiles', 'template_id', 'TEXT');

  // v6: opt-in per-source select groups. Off by default like prefix_nodes, and
  // for the same reason - it changes what clients see.
  ensureColumn(sqlite, 'profiles', 'source_groups', 'INTEGER NOT NULL DEFAULT 0');

  // v7: what kind of per-source group to build, and its probe settings. Every
  // default reproduces the v6 behaviour exactly - a plain select group - so an
  // existing profile is unaffected.
  ensureColumn(sqlite, 'profiles', 'source_group_type', `TEXT NOT NULL DEFAULT '${DEFAULT_SOURCE_GROUP_TYPE}'`);
  ensureColumn(sqlite, 'profiles', 'source_group_url', 'TEXT');
  ensureColumn(
    sqlite,
    'profiles',
    'source_group_interval',
    `INTEGER NOT NULL DEFAULT ${DEFAULT_SOURCE_GROUP_INTERVAL}`,
  );
  ensureColumn(
    sqlite,
    'profiles',
    'source_group_tolerance',
    `INTEGER NOT NULL DEFAULT ${DEFAULT_SOURCE_GROUP_TOLERANCE}`,
  );
}

runMigrations(sqlite);

/**
 * The SQLite INSTANCE is passed, not a factory.
 *
 * This is load-bearing. With a factory, Kysely would open a fresh connection
 * per acquisition and the pragmas above would apply only to the connection
 * configured here. With a shared instance, Kysely reuses this one handle
 * (better-sqlite3 is synchronous, so there is no pool to speak of) and the
 * pragmas are global. It also makes `await db.destroy()` close exactly this
 * handle.
 */
export const db = new Kysely<Database>({
  dialect: new SqliteDialect({ database: sqlite }),
});

export const databasePath = dbPath;

/* ------------------------------------------------------------------ *
 * Row -> domain mappers
 * ------------------------------------------------------------------ */

/**
 * SQLite has no boolean. The columns are nullable INTEGER with DEFAULT 1,
 * so NULL means "not specified" and should read as the default (true),
 * which is exactly what `v !== 0` does. `Boolean(v)` would get NULL wrong.
 */
function intToBool(v: number | null | undefined): boolean {
  return v !== 0;
}

/**
 * Fails SAFE. A corrupted row must not 500 every request for that profile
 * forever, so this is total: for any input it returns a result and never
 * throws.
 *
 * `valid` is false if the column was not a JSON array of strings. Note that
 * a partially-bad array still yields the good entries, with valid: false -
 * we degrade rather than discard, but the flag lets the caller complain.
 */
export function parseSourceIds(raw: unknown): { ids: string[]; valid: boolean } {
  if (typeof raw !== 'string' || raw.trim() === '') return { ids: [], valid: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ids: [], valid: false };
  }
  if (!Array.isArray(parsed)) return { ids: [], valid: false };

  const ids = parsed.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return { ids, valid: ids.length === parsed.length };
}

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: intToBool(row.enabled),
    createdAt: row.created_at,
  };
}

function toProfile(row: ProfileRow): Profile {
  const { ids, valid } = parseSourceIds(row.source_ids);
  return {
    key: row.key,
    // The column has DEFAULT 'clash' but is nullable, so an explicit NULL
    // written by hand would otherwise leak through as null.
    target: row.target ?? 'clash',
    sourceIds: ids,
    sourceIdsValid: valid,
    customRuleset: row.custom_ruleset,
    excludeRemarks: row.exclude_remarks,
    udp: intToBool(row.udp),
    // Deliberately not intToBool: that treats NULL as the column's default,
    // which is true for udp/enabled but false for expand. The migration above
    // normalises NULLs anyway; this is the belt to that braces.
    expand: row.expand === 1,
    autoUpdate: intToBool(row.auto_update),
    updateIntervalHours: row.update_interval_hours,
    prefixNodes: intToBool(row.prefix_nodes),
    sourceGroups: intToBool(row.source_groups),
    sourceGroupType: row.source_group_type || DEFAULT_SOURCE_GROUP_TYPE,
    sourceGroupUrl: row.source_group_url ?? null,
    sourceGroupInterval: row.source_group_interval,
    sourceGroupTolerance: row.source_group_tolerance,
    templateId: row.template_id ?? null,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------ *
 * Subscriptions
 * ------------------------------------------------------------------ */

export function newSubscriptionId(): string {
  return 'sub_' + randomBytes(8).toString('hex');
}

export async function listSubscriptions(): Promise<Subscription[]> {
  const rows = await db.selectFrom('subscriptions').selectAll().orderBy('created_at', 'desc').execute();
  return rows.map(toSubscription);
}

export async function getSubscription(id: string): Promise<Subscription | null> {
  const row = await db.selectFrom('subscriptions').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toSubscription(row) : null;
}

export async function upsertSubscription(input: UpsertSubscriptionInput): Promise<Subscription> {
  // Resolve every default here. Never let `undefined` reach the driver:
  // better-sqlite3 throws `TypeError: Invalid value` on an undefined bind.
  const id = input.id ?? newSubscriptionId();
  const enabled = input.enabled ?? true;

  await db
    .insertInto('subscriptions')
    .values({ id, name: input.name, url: input.url, enabled: enabled ? 1 : 0 })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        name: input.name,
        url: input.url,
        enabled: enabled ? 1 : 0,
        // created_at is deliberately absent - and `update: never` in the
        // table interface makes adding it a type error, not a silent bug.
      }),
    )
    .execute();

  // Read back so the response carries the authoritative created_at.
  const row = await db
    .selectFrom('subscriptions')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return toSubscription(row);
}

export async function deleteSubscription(id: string): Promise<boolean> {
  const result = await db.deleteFrom('subscriptions').where('id', '=', id).executeTakeFirst();
  // No foreign key exists on source_checks, so this has to be explicit.
  // Leaving it would strand a row that becomes invisible the moment its
  // subscription is gone - and would reappear if the id is ever reused.
  await deleteSourceChecksFor(id);
  return Number(result.numDeletedRows) > 0;
}

/**
 * Returns only enabled rows by default, in the SAME ORDER as `ids`, with
 * duplicates removed, skipping ids that do not exist or are disabled.
 *
 * Order matters: it is the user's chosen source order in the profile, and
 * the database has no column that expresses it.
 */
export async function listSubscriptionsByIds(
  ids: string[],
  opts: { enabledOnly?: boolean } = {},
): Promise<Subscription[]> {
  const unique = [...new Set(ids)];
  // Guard: Kysely renders `in ()` for an empty list, which is a SQL error.
  if (unique.length === 0) return [];

  const base = db.selectFrom('subscriptions').selectAll().where('id', 'in', unique);
  const query = (opts.enabledOnly ?? true) ? base.where('enabled', '=', 1) : base;

  const rows = await query.execute();
  const byId = new Map(rows.map((r) => [r.id, toSubscription(r)]));

  return unique.map((id) => byId.get(id)).filter((s): s is Subscription => s !== undefined);
}

/* ------------------------------------------------------------------ *
 * Profiles
 * ------------------------------------------------------------------ */

export async function listProfiles(): Promise<Profile[]> {
  const rows = await db.selectFrom('profiles').selectAll().orderBy('created_at', 'desc').execute();
  return rows.map(toProfile);
}

export async function getProfileByKey(key: string): Promise<Profile | null> {
  const row = await db.selectFrom('profiles').selectAll().where('key', '=', key).executeTakeFirst();
  return row ? toProfile(row) : null;
}

/**
 * Full replace of the mutable columns. Omitted optional fields reset to
 * their defaults (target='clash', udp=true, ruleset/exclude=null) rather
 * than being preserved - "undefined means keep" makes POST behave
 * differently depending on which keys happen to be present, which is a
 * worse contract for an API driven by curl and a web form.
 */
export async function upsertProfile(input: UpsertProfileInput): Promise<Profile> {
  const target = input.target ?? 'clash';
  const udp = input.udp ?? true;
  const customRuleset = input.customRuleset ?? null;
  const excludeRemarks = input.excludeRemarks ?? null;
  // undefined and null (from an older client) both mean false, which is now
  // the default rather than a third "unspecified" state.
  const expand = input.expand ?? false;
  const autoUpdate = input.autoUpdate ?? true;
  const updateIntervalHours = input.updateIntervalHours ?? DEFAULT_UPDATE_INTERVAL_HOURS;
  const prefixNodes = input.prefixNodes ?? false;
  const sourceGroups = input.sourceGroups ?? false;
  const sourceGroupType = input.sourceGroupType ?? DEFAULT_SOURCE_GROUP_TYPE;
  const sourceGroupUrl = input.sourceGroupUrl ?? null;
  const sourceGroupInterval = input.sourceGroupInterval ?? DEFAULT_SOURCE_GROUP_INTERVAL;
  const sourceGroupTolerance = input.sourceGroupTolerance ?? DEFAULT_SOURCE_GROUP_TOLERANCE;
  const templateId = input.templateId ?? null;

  await db
    .insertInto('profiles')
    .values({
      key: input.key,
      target,
      source_ids: JSON.stringify(input.sourceIds),
      custom_ruleset: customRuleset,
      exclude_remarks: excludeRemarks,
      udp: udp ? 1 : 0,
      expand: expand ? 1 : 0,
      auto_update: autoUpdate ? 1 : 0,
      update_interval_hours: updateIntervalHours,
      prefix_nodes: prefixNodes ? 1 : 0,
      source_groups: sourceGroups ? 1 : 0,
      source_group_type: sourceGroupType,
      source_group_url: sourceGroupUrl,
      source_group_interval: sourceGroupInterval,
      source_group_tolerance: sourceGroupTolerance,
      template_id: templateId,
    })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({
        target,
        source_ids: JSON.stringify(input.sourceIds),
        custom_ruleset: customRuleset,
        exclude_remarks: excludeRemarks,
        udp: udp ? 1 : 0,
        expand: expand ? 1 : 0,
        auto_update: autoUpdate ? 1 : 0,
        update_interval_hours: updateIntervalHours,
        prefix_nodes: prefixNodes ? 1 : 0,
        source_groups: sourceGroups ? 1 : 0,
        source_group_type: sourceGroupType,
        source_group_url: sourceGroupUrl,
        source_group_interval: sourceGroupInterval,
        source_group_tolerance: sourceGroupTolerance,
        template_id: templateId,
      }),
    )
    .execute();

  const row = await db
    .selectFrom('profiles')
    .selectAll()
    .where('key', '=', input.key)
    .executeTakeFirstOrThrow();
  return toProfile(row);
}

export async function deleteProfile(key: string): Promise<boolean> {
  const result = await db.deleteFrom('profiles').where('key', '=', key).executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

/* ------------------------------------------------------------------ *
 * Rulesets
 *
 * A picker for the `config=` template, nothing more. Profiles store the URL
 * itself, so nothing here is load-bearing for an existing config: deleting a
 * ruleset removes it from the dropdown and leaves every profile untouched.
 * ------------------------------------------------------------------ */

function toRuleset(row: RulesetRow): Ruleset {
  return { id: row.id, name: row.name, url: row.url, createdAt: row.created_at };
}

export function newRulesetId(): string {
  return 'rst_' + randomBytes(8).toString('hex');
}

export async function listRulesets(): Promise<Ruleset[]> {
  const rows = await db.selectFrom('rulesets').selectAll().orderBy('created_at', 'desc').execute();
  return rows.map(toRuleset);
}

export async function upsertRuleset(input: UpsertRulesetInput): Promise<Ruleset> {
  const id = input.id ?? newRulesetId();

  await db
    .insertInto('rulesets')
    .values({ id, name: input.name, url: input.url })
    .onConflict((oc) =>
      // name and url are replaced; created_at is not, for the same reason as
      // everywhere else - `update: never` makes mentioning it a type error.
      oc.column('id').doUpdateSet({ name: input.name, url: input.url }),
    )
    .execute();

  const row = await db
    .selectFrom('rulesets')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return toRuleset(row);
}

export async function deleteRuleset(id: string): Promise<boolean> {
  const result = await db.deleteFrom('rulesets').where('id', '=', id).executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

/* ------------------------------------------------------------------ *
 * Source checks
 *
 * Runtime state rather than configuration: one row per source, overwritten on
 * every run. It lives in its own table so `subscriptions` stays purely what
 * the operator set up, and so a lost monitor never looks like lost config.
 * ------------------------------------------------------------------ */

function toSourceCheck(row: SourceCheckRow): SourceCheck {
  return {
    sourceId: row.source_id,
    checkedAt: row.checked_at,
    ok: intToBool(row.ok),
    nodeCount: row.node_count,
    upload: row.upload,
    download: row.download,
    total: row.total,
    expire: row.expire,
    httpStatus: row.http_status,
    error: row.error,
    latencyMs: row.latency_ms,
  };
}

export async function listSourceChecks(): Promise<SourceCheck[]> {
  const rows = await db.selectFrom('source_checks').selectAll().execute();
  return rows.map(toSourceCheck);
}

export async function getSourceCheck(sourceId: string): Promise<SourceCheck | null> {
  const row = await db
    .selectFrom('source_checks')
    .selectAll()
    .where('source_id', '=', sourceId)
    .executeTakeFirst();
  return row ? toSourceCheck(row) : null;
}

export async function upsertSourceCheck(input: UpsertSourceCheckInput): Promise<SourceCheck> {
  // Set explicitly rather than relying on the column default: a default only
  // applies on INSERT, so an upsert that omitted this would keep reporting the
  // time of the very first check forever. Formatted like SQLite's
  // CURRENT_TIMESTAMP (UTC, 'YYYY-MM-DD HH:MM:SS') to match the other tables.
  const checkedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const values = {
    source_id: input.sourceId,
    checked_at: checkedAt,
    ok: input.ok ? 1 : 0,
    node_count: input.nodeCount,
    upload: input.upload,
    download: input.download,
    total: input.total,
    expire: input.expire,
    http_status: input.httpStatus,
    error: input.error,
    latency_ms: input.latencyMs,
  };

  await db
    .insertInto('source_checks')
    .values(values)
    // source_id is the conflict target and is set to itself here - a no-op,
    // and simpler than building a second object that omits it.
    .onConflict((oc) => oc.column('source_id').doUpdateSet(values))
    .execute();

  const row = await db
    .selectFrom('source_checks')
    .selectAll()
    .where('source_id', '=', input.sourceId)
    .executeTakeFirstOrThrow();
  return toSourceCheck(row);
}

export async function deleteSourceChecksFor(sourceId: string): Promise<boolean> {
  const result = await db
    .deleteFrom('source_checks')
    .where('source_id', '=', sourceId)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

/* ------------------------------------------------------------------ *
 * Templates
 *
 * Like rulesets, these are operator-managed - but unlike rulesets a profile
 * REFERENCES one by id rather than copying a URL. That makes deleting one a
 * different proposition: profilesUsingTemplate() exists so the route can
 * refuse instead of leaving a profile pointing at nothing.
 * ------------------------------------------------------------------ */

function toTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function newTemplateId(): string {
  return 'tpl_' + randomBytes(8).toString('hex');
}

export async function listTemplates(): Promise<Template[]> {
  const rows = await db.selectFrom('templates').selectAll().orderBy('created_at', 'desc').execute();
  return rows.map(toTemplate);
}

export async function getTemplate(id: string): Promise<Template | null> {
  const row = await db.selectFrom('templates').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toTemplate(row) : null;
}

export async function upsertTemplate(input: UpsertTemplateInput): Promise<Template> {
  const id = input.id ?? newTemplateId();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  await db
    .insertInto('templates')
    .values({ id, name: input.name, content: input.content, updated_at: now })
    .onConflict((oc) =>
      // updated_at is written explicitly here, unlike every other table's
      // created_at - an edit is the event this column records.
      oc.column('id').doUpdateSet({ name: input.name, content: input.content, updated_at: now }),
    )
    .execute();

  const row = await db
    .selectFrom('templates')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return toTemplate(row);
}

/** Profiles that would break if this template were removed. */
export async function profilesUsingTemplate(id: string): Promise<string[]> {
  const rows = await db
    .selectFrom('profiles')
    .select('key')
    .where('template_id', '=', id)
    .execute();
  return rows.map((r) => r.key);
}

export async function deleteTemplate(id: string): Promise<boolean> {
  const result = await db.deleteFrom('templates').where('id', '=', id).executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

export async function pingDb(): Promise<boolean> {
  try {
    await db.selectFrom('subscriptions').select('id').limit(1).execute();
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await db.destroy();
  // Defensive and idempotent: db.destroy() normally closes the handle, but
  // if it was already closed `sqlite.open` is false and this is a no-op.
  if (sqlite.open) sqlite.close();
}
