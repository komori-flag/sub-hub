/**
 * Adds a `[source] ` prefix to every node name in a Clash config.
 *
 * Why this is not a Subconverter parameter: measured against v0.9.9, none
 * exists. `rename`, `rename_node` and `prefix` are all silently ignored - and
 * `emoji=true` does change names, which proves the probe could have detected
 * an effect had there been one. So the rewrite happens here.
 *
 * The hard part is not the proxies block. It is that proxy-groups reference
 * nodes BY NAME:
 *
 *     proxy-groups:
 *       - name: 🔰 节点选择
 *         proxies:
 *           - HK-01          <- the same string again
 *
 * Prefixing one and not the other leaves every group pointing at names that no
 * longer exist - a config that is broken silently rather than rejected.
 *
 * Everything here is pure so it can be tested directly; this is exactly the
 * kind of code that fails quietly.
 */

/** `[机场甲] HK-01` */
export function prefixFor(sourceName: string): string {
  return '[' + sourceName + '] ';
}

/**
 * Node names in document order, from the `proxies:` block.
 *
 * Handles both flow style (`- {name: X, server: ...}`), which is what
 * Subconverter emits by default, and block style (`- name: X`).
 */
export function extractNodeNames(yaml: string): string[] {
  return scanNodes(yaml).names;
}

export interface NodeScan {
  names: string[];
  /**
   * Entries that look like nodes but yielded no name.
   *
   * Non-zero means the block holds content in a shape this parser does not
   * read. Reporting it matters because the alternative is silence: an empty
   * name list simply produces nothing to rename, so the feature would appear
   * to work while doing nothing at all.
   */
  unreadable: number;
  /**
   * The whole block sits on the `proxies:` line itself
   * (`proxies: [{...}, {...}]`), which Subconverter emits when
   * `clash_proxies_style = "compact"`. Nothing can be read from it without a
   * real YAML parser.
   */
  inline: boolean;
}

export function scanNodes(yaml: string): NodeScan {
  const result: NodeScan = { names: [], unreadable: 0, inline: false };
  const lines = yaml.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const header = /^proxies:(.*)$/.exec(lines[i]!);
    if (!header) continue;

    const rest = header[1]!.trim();
    if (rest === '[]') return result; // genuinely empty, not a failure
    if (rest !== '') {
      result.inline = true;
      return result;
    }

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line !== '' && !/^\s/.test(line)) break; // next top-level key
      if (!/^\s+-/.test(line)) continue;

      const name = readEntryName(line);
      if (name === null) result.unreadable++;
      else result.names.push(name);
    }
    return result;
  }

  return result;
}

/** Group names, from the `proxy-groups:` block. */
export function extractGroupNames(yaml: string): string[] {
  return scanGroups(yaml).names;
}

export interface GroupScan {
  names: string[];
  /**
   * Flow-style entries (`- {name: G, proxies: [A, B]}`).
   *
   * Counted separately from `inline` because the consequence would be worse:
   * a group written this way keeps its node references on the same line, and
   * applyNodePrefix only rewrites `- <name>` lines - so the nodes would be
   * renamed while the groups kept pointing at the old names, which is a broken
   * config rather than an unchanged one.
   *
   * Measured, and worth knowing before trusting this: against v0.9.9 the
   * `clash_proxy_groups_style = "flow"` setting has NO effect - groups come out
   * block-style regardless, so this branch cannot currently fire. It is kept as
   * a guard for a version that does honour the setting, or an output shape that
   * arrives some other way. `clash_proxies_style = "compact"` DOES take effect,
   * which is why the node-side check is load-bearing and this one is not.
   */
  inlineEntries: number;
  /** The whole block sits on the `proxy-groups:` line itself. */
  inline: boolean;
}

export function scanGroups(yaml: string): GroupScan {
  const result: GroupScan = { names: [], inlineEntries: 0, inline: false };
  const lines = yaml.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const header = /^proxy-groups:(.*)$/.exec(lines[i]!);
    if (!header) continue;

    const rest = header[1]!.trim();
    if (rest === '[]') return result;
    if (rest !== '') {
      result.inline = true;
      return result;
    }

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line !== '' && !/^\s/.test(line)) break;
      if (/^\s+-\s*\{/.test(line)) {
        result.inlineEntries++;
        continue;
      }
      const block = /^\s+-\s*name:\s*(.+?)\s*$/.exec(line);
      if (block) result.names.push(block[1]!);
    }
    return result;
  }

  return result;
}

function readEntryName(line: string): string | null {
  const flow = /^\s+-\s*\{\s*name:\s*([^,}]+?)\s*[,}]/.exec(line);
  if (flow) return flow[1]!;
  const block = /^\s+-\s*name:\s*(.+?)\s*$/.exec(line);
  if (block) return block[1]!;
  return null;
}

export type PrefixPlan =
  | { ok: true; mapping: Map<string, string> }
  | { ok: false; reason: string };

/**
 * Works out old name -> new name, or explains why it will not.
 *
 * Declining is a real outcome, not an error path: the caller ships the config
 * unchanged rather than guessing. The case that forces it is two sources
 * offering a node with the same name - then there is genuinely no way to tell
 * which airport that node came from, and attributing it to either would be
 * inventing information.
 */
export function buildPrefixPlan(
  nodeNames: string[],
  owners: Map<string, string[]>,
  groupNames: string[],
): PrefixPlan {
  const groups = new Set(groupNames);
  const mapping = new Map<string, string>();

  for (const name of nodeNames) {
    const found = owners.get(name);
    if (found === undefined || found.length === 0) {
      return { ok: false, reason: `node "${name}" came from no known source` };
    }
    if (found.length > 1) {
      return { ok: false, reason: `node "${name}" exists in ${found.length} sources` };
    }
    if (groups.has(name)) {
      return { ok: false, reason: `"${name}" is both a node and a group name` };
    }
    mapping.set(name, prefixFor(found[0]!) + name);
  }

  return { ok: true, mapping };
}

/* ------------------------------------------------------------------ *
 * Per-source groups
 *
 * The counterpart to prefixing: one select group per source, so a client can
 * choose an airport instead of picking through one flat node list.
 *
 * APPEND ONLY. The existing groups are never touched - not reordered, not
 * re-referenced. That is the whole defence against not knowing what the
 * template produces: since nothing existing is modified, an unfamiliar group
 * structure cannot be damaged by this. A mistake can only ever mean the new
 * groups are missing.
 *
 * The alternative - hanging the new groups off an existing one, so a client
 * picks the airport inside Proxy - would require finding that group by
 * guessing at the template's structure. It buys a slightly tidier group list
 * in exchange for the ability to corrupt a config.
 * ------------------------------------------------------------------ */

/**
 * YAML needs quoting for a value that starts with an indicator character, and
 * a prefixed node name always starts with `[` - which is one. Subconverter
 * quotes them for the same reason; unquoted, `- [甲] HK-01` would parse as a
 * nested sequence.
 */
function yamlString(text: string): string {
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export type GroupsResult =
  | { ok: true; yaml: string; names: string[] }
  | { ok: false; reason: string };

/** How the generated groups should behave. */
export interface GroupSpec {
  /** select | url-test | load-balance | fallback */
  type: string;
  /** Probe URL. Only emitted for the testing types. */
  url: string | null;
  interval: number;
  tolerance: number;
}

/**
 * Builds the YAML block for one group per source.
 *
 * Refuses on a name collision rather than renaming: a group whose name matches
 * an existing one would shadow it, and quietly dropping a source's group would
 * hide the problem instead.
 */
export function buildSourceGroups(
  bySource: Map<string, string[]>,
  existingGroupNames: string[],
  spec: GroupSpec,
): GroupsResult {
  const existing = new Set(existingGroupNames);
  const blocks: string[] = [];
  const names: string[] = [];
  const testing = spec.type !== 'select';

  for (const [sourceName, nodeNames] of bySource) {
    if (nodeNames.length === 0) continue;
    if (existing.has(sourceName)) {
      return { ok: false, reason: `group name "${sourceName}" collides with an existing group` };
    }

    names.push(sourceName);
    const lines = ['  - name: ' + yamlString(sourceName), '    type: ' + spec.type];

    // Only the testing types take these. Emitting them on a select group would
    // be accepted but meaningless, and would make the output harder to read
    // against what the operator configured.
    if (testing) {
      if (spec.url !== null) lines.push('    url: ' + yamlString(spec.url));
      lines.push('    interval: ' + spec.interval);
      lines.push('    tolerance: ' + spec.tolerance);
    }

    lines.push('    proxies:');
    for (const name of nodeNames) lines.push('      - ' + yamlString(name));
    blocks.push(lines.join('\n'));
  }

  if (names.length === 0) return { ok: false, reason: 'no source had any nodes' };
  return { ok: true, yaml: blocks.join('\n'), names };
}

/** Inserts a block at the end of the `proxy-groups` section. */
export function appendToGroupSection(
  yaml: string,
  block: string,
): { ok: true; content: string } | { ok: false; reason: string } {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => /^proxy-groups:/.test(line));
  if (start === -1) return { ok: false, reason: 'the config has no proxy-groups section' };

  // The section ends at the next line back at column 0.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] !== '' && !/^\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }

  const out = lines.slice();
  out.splice(end, 0, ...block.split('\n'));
  return { ok: true, content: out.join('\n') };
}

/**
 * Rewrites the YAML line by line.
 *
 * Deliberately not a global string replace: a node called `HK-01` and another
 * called `HK-011` would corrupt each other, and names can appear in rules or
 * comments where they must not be touched. Matching is anchored to the exact
 * two shapes a name takes - a `name:` field, or a bare `- <name>` reference -
 * and only applies when the extracted value is one we planned to rename.
 */
export function applyNodePrefix(yaml: string, mapping: Map<string, string>): string {
  if (mapping.size === 0) return yaml;

  return yaml
    .split('\n')
    .map((line) => {
      // name field, flow style:  - {name: HK-01, server: ...}
      const flow = /^(\s*-\s*\{\s*name:\s*)([^,}]+?)(\s*[,}])/.exec(line);
      if (flow) {
        const renamed = mapping.get(flow[2]!);
        if (renamed !== undefined) {
          return flow[1]! + renamed + flow[3]! + line.slice(flow[0]!.length);
        }
        return line;
      }

      // name field, block style:  - name: HK-01
      const block = /^(\s*-\s*name:\s*)(.+?)(\s*)$/.exec(line);
      if (block) {
        const renamed = mapping.get(block[2]!);
        if (renamed !== undefined) return block[1]! + renamed + block[3]!;
        return line;
      }

      // bare reference, as used inside a group's proxies list:  - HK-01
      const ref = /^(\s*-\s+)(.+?)(\s*)$/.exec(line);
      if (ref) {
        const renamed = mapping.get(ref[2]!);
        if (renamed !== undefined) return ref[1]! + renamed + ref[3]!;
        return line;
      }

      return line;
    })
    .join('\n');
}
