// Must come first - see test/setup.ts.
import './setup.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import SQLite from 'better-sqlite3';

import { hasColumn, runMigrations } from '../src/db.js';

/**
 * A profiles table as it existed BEFORE the expand column - which is the shape
 * every already-deployed database has. Written out literally rather than
 * derived from the current DDL, because the point is to reproduce an old
 * database, not the current one.
 */
const OLD_PROFILES_DDL = `
CREATE TABLE profiles (
    key TEXT PRIMARY KEY,
    target TEXT DEFAULT 'clash',
    source_ids TEXT NOT NULL,
    custom_ruleset TEXT,
    exclude_remarks TEXT,
    udp INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * The intermediate shape: expand exists but is nullable with NULLs in it, as
 * written by the version that treated it as tri-state.
 */
const V1_PROFILES_DDL = `
CREATE TABLE profiles (
    key TEXT PRIMARY KEY,
    target TEXT DEFAULT 'clash',
    source_ids TEXT NOT NULL,
    custom_ruleset TEXT,
    exclude_remarks TEXT,
    udp INTEGER DEFAULT 1,
    expand INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

function withSchema(ddl: string): InstanceType<typeof SQLite> {
  const db = new SQLite(':memory:');
  db.exec(ddl);
  return db;
}

function insertProfile(db: InstanceType<typeof SQLite>, key: string): void {
  db.prepare(
    `INSERT INTO profiles (key, target, source_ids, custom_ruleset, exclude_remarks, udp)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(key, 'clash', '["sub_01"]', null, null, 1);
}

type Row = {
  key: string;
  target: string;
  source_ids: string;
  udp: number;
  expand: number | null;
};

describe('runMigrations', () => {
  it('adds the expand column to a database that predates it', () => {
    const db = withSchema(OLD_PROFILES_DDL);
    assert.equal(hasColumn(db, 'profiles', 'expand'), false);

    runMigrations(db);

    assert.equal(hasColumn(db, 'profiles', 'expand'), true);
    db.close();
  });

  it('defaults pre-existing rows to 0, not NULL and not 1', () => {
    // The behaviour change this migration exists for: a profile that never
    // mentioned expand used to inline every ruleset. It must now come out as
    // false without the operator touching it.
    const db = withSchema(OLD_PROFILES_DDL);
    insertProfile(db, 'kept');

    runMigrations(db);

    const row = db
      .prepare('SELECT key, target, source_ids, udp, expand FROM profiles')
      .get() as Row;

    assert.equal(row.key, 'kept');
    assert.equal(row.target, 'clash');
    assert.equal(row.source_ids, '["sub_01"]');
    assert.equal(row.udp, 1);
    assert.equal(row.expand, 0, 'a pre-existing row must become 0, not stay NULL');
    db.close();
  });

  it('normalises NULLs left by the tri-state version', () => {
    // The actual upgrade path for an already-deployed database: expand exists,
    // was nullable, and holds NULL for every row.
    const db = withSchema(V1_PROFILES_DDL);
    insertProfile(db, 'legacy');
    db.prepare('UPDATE profiles SET expand = NULL WHERE key = ?').run('legacy');

    const before = db.prepare('SELECT expand FROM profiles WHERE key = ?').get('legacy') as {
      expand: number | null;
    };
    assert.equal(before.expand, null, 'precondition: the row starts NULL');

    runMigrations(db);

    const after = db.prepare('SELECT expand FROM profiles WHERE key = ?').get('legacy') as {
      expand: number | null;
    };
    assert.equal(after.expand, 0);
    db.close();
  });

  it('leaves an explicit 1 alone', () => {
    // Someone who deliberately turned inlining on must not have it switched
    // off by the migration - only NULL is rewritten.
    const db = withSchema(V1_PROFILES_DDL);
    insertProfile(db, 'explicit');
    db.prepare('UPDATE profiles SET expand = 1 WHERE key = ?').run('explicit');

    runMigrations(db);

    const row = db.prepare('SELECT expand FROM profiles WHERE key = ?').get('explicit') as {
      expand: number;
    };
    assert.equal(row.expand, 1);
    db.close();
  });

  it('is idempotent, so a fresh database is a no-op', () => {
    // A new install gets the column from the DDL, so this path must not throw
    // "duplicate column name" when it runs there.
    const db = withSchema(V1_PROFILES_DDL);
    runMigrations(db);
    runMigrations(db);
    runMigrations(db);

    const columns = (db.pragma('table_info(profiles)') as Array<{ name: string }>).filter(
      (c) => c.name === 'expand',
    );
    assert.equal(columns.length, 1, 'exactly one expand column');
    db.close();
  });

  it('does not disturb other columns', () => {
    const db = withSchema(OLD_PROFILES_DDL);
    const before = (db.pragma('table_info(profiles)') as Array<{ name: string }>).map((c) => c.name);

    runMigrations(db);

    const after = (db.pragma('table_info(profiles)') as Array<{ name: string }>).map((c) => c.name);
    assert.deepEqual(after, [
      ...before,
      'expand',
      'auto_update',
      'update_interval_hours',
      'prefix_nodes',
      'template_id',
      'source_groups',
      'source_group_type',
      'source_group_url',
      'source_group_interval',
      'source_group_tolerance',
    ]);
    db.close();
  });

  it('backfills auto-update with the values the old behaviour implied', () => {
    // Before these were settings, the short link unconditionally sent
    // `Profile-Update-Interval: 24`. An existing profile has to come out
    // exactly that way - not "off", and not some other interval - or the
    // migration would silently change how every client refreshes.
    const db = withSchema(OLD_PROFILES_DDL);
    insertProfile(db, 'kept');

    runMigrations(db);

    const row = db
      .prepare('SELECT auto_update, update_interval_hours FROM profiles WHERE key = ?')
      .get('kept') as { auto_update: number; update_interval_hours: number };

    assert.equal(row.auto_update, 1);
    assert.equal(row.update_interval_hours, 24);
    db.close();
  });

  it('adds the auto-update columns to a tri-state-expand database too', () => {
    // The upgrade path from the version that is actually deployed: expand
    // exists and is nullable, the auto-update columns do not exist yet.
    const db = withSchema(V1_PROFILES_DDL);
    insertProfile(db, 'legacy');

    runMigrations(db);

    const row = db
      .prepare(
        'SELECT expand, auto_update, update_interval_hours, prefix_nodes, template_id, source_groups, source_group_type, source_group_interval, source_group_tolerance FROM profiles WHERE key = ?',
      )
      .get('legacy') as {
      expand: number;
      auto_update: number;
      update_interval_hours: number;
      prefix_nodes: number;
      template_id: string | null;
      source_groups: number;
      source_group_type: string;
      source_group_interval: number;
      source_group_tolerance: number;
    };

    assert.equal(row.expand, 0);
    assert.equal(row.auto_update, 1);
    assert.equal(row.update_interval_hours, 24);
    // Opt-in, so an existing profile must not start paying for extra
    // conversions.
    assert.equal(row.prefix_nodes, 0);
    // NULL is the right default here, and different from "empty template":
    // it means this profile has no local template and keeps using its URL.
    assert.equal(row.template_id, null);
    // Also opt-in: it changes what the client's group list looks like.
    assert.equal(row.source_groups, 0);
    // These defaults reproduce exactly what a v6 profile did - a plain select
    // group - so an existing profile's output is unchanged.
    assert.equal(row.source_group_type, 'select');
    assert.equal(row.source_group_interval, 300);
    assert.equal(row.source_group_tolerance, 50);
    db.close();
  });
});
