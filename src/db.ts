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
  Subscription,
  SubscriptionRow,
  UpsertProfileInput,
  UpsertSubscriptionInput,
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

  await db
    .insertInto('profiles')
    .values({
      key: input.key,
      target,
      source_ids: JSON.stringify(input.sourceIds),
      custom_ruleset: customRuleset,
      exclude_remarks: excludeRemarks,
      udp: udp ? 1 : 0,
    })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({
        target,
        source_ids: JSON.stringify(input.sourceIds),
        custom_ruleset: customRuleset,
        exclude_remarks: excludeRemarks,
        udp: udp ? 1 : 0,
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
