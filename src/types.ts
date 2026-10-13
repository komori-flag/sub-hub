import type { ColumnType, Selectable } from 'kysely';

/* ------------------------------------------------------------------ *
 * Kysely table interfaces.
 *
 * These mirror the DATABASE, not the domain model. SQLite has no boolean
 * and no date type: `enabled`/`udp` are INTEGER 0/1 and `created_at` is a
 * DATETIME stored as text. Declaring them honestly here is what forces the
 * row -> domain coercion to happen in db.ts instead of being forgotten.
 * ------------------------------------------------------------------ */

export interface SubscriptionsTable {
  id: string;
  name: string;
  url: string;
  /** SQLite INTEGER 0/1, column DEFAULT 1. Coerced to boolean in toSubscription(). */
  enabled: number;
  /**
   * ColumnType<Select, Insert, Update>.
   *
   * `update: never` is load-bearing, not decoration: it makes mentioning
   * created_at inside .doUpdateSet() a COMPILE error, so an upsert cannot
   * clobber the original creation time. `Generated<string>` is the common
   * shorthand but expands to ColumnType<string, string|undefined, string>,
   * which would happily let you overwrite it.
   */
  created_at: ColumnType<string, string | undefined, never>;
}

export interface ProfilesTable {
  key: string;
  target: string;
  /** JSON array string, e.g. '["sub_01","sub_02"]'. Parsed defensively by toProfile(). */
  source_ids: string;
  custom_ruleset: string | null;
  exclude_remarks: string | null;
  /** SQLite INTEGER 0/1, column DEFAULT 1. Coerced to boolean in toProfile(). */
  udp: number;
  /**
   * SQLite INTEGER 0/1, but DEFAULT 0 - the only flag here whose default is
   * false. Inlining rulesets is the expensive option, so it is opt-in rather
   * than something you have to remember to turn off.
   */
  expand: ColumnType<number, number | undefined, number>;
  /**
   * Whether to advertise an update interval to the client on the short link.
   *
   * A suggestion, not a control: the header only tells a client how often it
   * may re-fetch, and a client's own auto-update setting always wins. Turning
   * this off stops the suggestion being sent; it cannot stop a client that is
   * configured to poll anyway.
   */
  auto_update: ColumnType<number, number | undefined, number>;
  /** Hours, sent as `Profile-Update-Interval`. 24 matches what was hardcoded before. */
  update_interval_hours: ColumnType<number, number | undefined, number>;
  /**
   * Prefix each node's name with the subscription it came from, e.g.
   * `HK-01` -> `[机场甲] HK-01`. Off by default; it costs extra conversions.
   */
  prefix_nodes: ColumnType<number, number | undefined, number>;
  /**
   * Add a select group per subscription source, listing that source's nodes.
   *
   * Separate from prefix_nodes even though they are usually wanted together:
   * the prefix changes how nodes are labelled, this changes what the client
   * can select, and either is useful without the other.
   */
  source_groups: ColumnType<number, number | undefined, number>;
  /**
   * What kind of group to build per source.
   *
   * `select` lets a person choose an airport; `url-test` picks the fastest
   * node within one, which is what makes a `fallback` across airports work.
   * Only matters when source_groups is on.
   */
  source_group_type: ColumnType<string, string | undefined, string>;
  /** Probe URL for the testing group types. Null -> the built-in default. */
  source_group_url: ColumnType<string | null, string | null | undefined, string | null>;
  /** Probe interval in seconds, and the tolerance that keeps a test from flapping. */
  source_group_interval: ColumnType<number, number | undefined, number>;
  source_group_tolerance: ColumnType<number, number | undefined, number>;
  /** Null when the profile uses no local template (or no template at all). */
  template_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<string, string | undefined, never>;
}

export interface RulesetsTable {
  id: string;
  name: string;
  /** The template URL, passed to Subconverter as `config=`. */
  url: string;
  created_at: ColumnType<string, string | undefined, never>;
}

export interface SourceChecksTable {
  source_id: string;
  /**
   * The one column here whose Update type is NOT `never`, unlike every
   * created_at: this is a last-checked timestamp, so it must change on every
   * upsert. It records when the row was refreshed, not when it appeared.
   */
  checked_at: ColumnType<string, string | undefined, string>;
  ok: number;
  /** Null, not 0, when the check failed - 0 would read as "the source is empty". */
  node_count: number | null;
  upload: number | null;
  download: number | null;
  total: number | null;
  /** Unix seconds, as reported by the provider. */
  expire: number | null;
  http_status: number | null;
  error: string | null;
  latency_ms: number | null;
}

export interface TemplatesTable {
  id: string;
  name: string;
  /**
   * The .ini document, stored verbatim.
   *
   * Held here rather than fetched per request because the whole point is to
   * support templates that cannot be published - internal hostnames, tunnel
   * endpoints. A template that must live in a public repo is the case this
   * exists to avoid.
   */
  content: string;
  created_at: ColumnType<string, string | undefined, never>;
  /** Unlike every other timestamp here, this one changes: edits are expected. */
  updated_at: ColumnType<string, string | undefined, string>;
}

export interface Database {
  subscriptions: SubscriptionsTable;
  profiles: ProfilesTable;
  rulesets: RulesetsTable;
  source_checks: SourceChecksTable;
  templates: TemplatesTable;
}

export type SubscriptionRow = Selectable<SubscriptionsTable>;
export type ProfileRow = Selectable<ProfilesTable>;
export type RulesetRow = Selectable<RulesetsTable>;
export type SourceCheckRow = Selectable<SourceChecksTable>;
export type TemplateRow = Selectable<TemplatesTable>;

/* ------------------------------------------------------------------ *
 * Domain types - what the rest of the app sees.
 * Booleans are real booleans, source_ids is a real string[].
 * ------------------------------------------------------------------ */

export interface Subscription {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: string;
}

export interface Profile {
  key: string;
  target: string;
  sourceIds: string[];
  /**
   * false when the stored source_ids was not a JSON array of strings. The
   * request path uses this to fail loudly instead of silently serving an
   * empty config built from zero sources.
   */
  sourceIdsValid: boolean;
  customRuleset: string | null;
  excludeRemarks: string | null;
  udp: boolean;
  /**
   * Whether Subconverter inlines rulesets into the config. Defaults to false.
   *
   * Worth knowing: leaving it true (or letting Subconverter use its own
   * default, which is true) turned a 19 KB config into 5.2 MB with a ruleset
   * template, and 29 KB into 547 KB without one. `false` emits rule-providers
   * and lets the client fetch and cache the rulesets itself.
   */
  expand: boolean;
  /** Advertise an update interval to the client. See ProfilesTable.auto_update. */
  autoUpdate: boolean;
  /** Hours, for the `Profile-Update-Interval` response header. */
  updateIntervalHours: number;
  /** Whether node names carry their source as a prefix. */
  prefixNodes: boolean;
  /** Whether each source gets its own group. */
  sourceGroups: boolean;
  /** select | url-test | load-balance | fallback. See the table interface. */
  sourceGroupType: string;
  sourceGroupUrl: string | null;
  sourceGroupInterval: number;
  sourceGroupTolerance: number;
  /**
   * A locally stored template to use instead of `customRuleset`. Both are
   * optional; when this is set it wins, so a profile can switch between a
   * published template and a private one without losing either.
   */
  templateId: string | null;
  createdAt: string;
}

/**
 * A named ruleset template you can pick from when creating a profile, instead
 * of pasting its URL every time.
 *
 * A profile still stores the URL itself, not a reference to this row, so
 * renaming or deleting a ruleset never changes or breaks an existing profile.
 * This table is a picker, not a source of truth the config depends on.
 */
export interface Ruleset {
  id: string;
  name: string;
  url: string;
  createdAt: string;
}

/* ---- write inputs ---- */

/** A template the operator edits in the console and sub-hub serves itself. */
export interface Template {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertTemplateInput {
  id?: string;
  name: string;
  content: string;
}

/**
 * The latest check of one subscription source. One row per source, overwritten
 * each run - there is no history, so this answers "is it working now", not
 * "how long has it been down".
 */
export interface SourceCheck {
  sourceId: string;
  checkedAt: string;
  ok: boolean;
  nodeCount: number | null;
  upload: number | null;
  download: number | null;
  total: number | null;
  expire: number | null;
  httpStatus: number | null;
  error: string | null;
  latencyMs: number | null;
}

export interface UpsertSourceCheckInput {
  sourceId: string;
  ok: boolean;
  nodeCount: number | null;
  upload: number | null;
  download: number | null;
  total: number | null;
  expire: number | null;
  httpStatus: number | null;
  error: string | null;
  latencyMs: number | null;
}

export interface UpsertSubscriptionInput {
  /** Omitted -> generated by newSubscriptionId(). */
  id?: string;
  name: string;
  url: string;
  /** Defaults to true. */
  enabled?: boolean;
}

export interface UpsertRulesetInput {
  /** Omitted -> generated by newRulesetId(). */
  id?: string;
  name: string;
  url: string;
}

export interface UpsertProfileInput {
  key: string;
  /** Defaults to 'clash'. */
  target?: string;
  /** Required; already validated and de-duplicated by the route. */
  sourceIds: string[];
  /** Defaults to null. */
  customRuleset?: string | null;
  /** Defaults to null. */
  excludeRemarks?: string | null;
  /** Defaults to true. */
  udp?: boolean;
  /** Defaults to false - inlining is the expensive option, so it is opt-in. */
  expand?: boolean;
  /** Defaults to true. */
  autoUpdate?: boolean;
  /** Defaults to 24. Ignored when autoUpdate is false. */
  updateIntervalHours?: number;
  /** Defaults to false. */
  prefixNodes?: boolean;
  /** Defaults to false. */
  sourceGroups?: boolean;
  /** Defaults to 'select'. */
  sourceGroupType?: string;
  /** Defaults to the built-in probe URL. */
  sourceGroupUrl?: string | null;
  /** Defaults to 300. */
  sourceGroupInterval?: number;
  /** Defaults to 50. */
  sourceGroupTolerance?: number;
  /** A local template id. Takes precedence over customRuleset when set. */
  templateId?: string | null;
}

/* ---- shared API error shape ---- */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
