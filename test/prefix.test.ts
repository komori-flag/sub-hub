// Must come first - see test/setup.ts.
import './setup.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GroupSpec } from '../src/services/prefix.js';
import {
  appendToGroupSection,
  applyNodePrefix,
  buildPrefixPlan,
  buildSourceGroups,
  extractGroupNames,
  extractNodeNames,
  prefixFor,
  scanGroups,
  scanNodes,
} from '../src/services/prefix.js';

/** The shape Subconverter actually emits. */
const SAMPLE = [
  'port: 7890',
  'mode: Rule',
  'proxies:',
  '  - {name: HK-01, server: hk1.example.com, port: 1, type: ss}',
  '  - {name: HK-02, server: hk2.example.com, port: 2, type: ss}',
  '  - {name: JP-01, server: jp1.example.com, port: 3, type: ss}',
  'proxy-groups:',
  '  - name: 🔰 节点选择',
  '    type: select',
  '    proxies:',
  '      - ♻️ 自动选择',
  '      - 🎯 全球直连',
  '      - HK-01',
  '      - HK-02',
  '      - JP-01',
  'rules:',
  '  - MATCH,🔰 节点选择',
  '',
].join('\n');

/** node name -> the sources that offer it */
function owners(entries: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(entries));
}

describe('scanNodes', () => {
  // These exist because the failure mode they guard against is silence. An
  // unreadable block yields no names, which yields nothing to rename, which
  // looks exactly like success from the outside.

  it('is clean for the flow style Subconverter emits by default', () => {
    const scan = scanNodes(SAMPLE);
    assert.deepEqual(scan.names, ['HK-01', 'HK-02', 'JP-01']);
    assert.equal(scan.unreadable, 0);
    assert.equal(scan.inline, false);
  });

  it('is clean for block style too', () => {
    const yaml = ['proxies:', '  - name: A', '    type: ss', '  - name: B'].join('\n');
    const scan = scanNodes(yaml);
    assert.deepEqual(scan.names, ['A', 'B']);
    assert.equal(scan.unreadable, 0);
  });

  it('flags a single-line block as inline (compact style)', () => {
    // clash_proxies_style = "compact"
    const scan = scanNodes('proxies: [{name: A, server: x}, {name: B, server: y}]\n');
    assert.equal(scan.inline, true);
    assert.deepEqual(scan.names, []);
  });

  it('treats an explicit empty list as empty, not as a failure', () => {
    const scan = scanNodes('port: 7890\nproxies: []\nproxy-groups: []\n');
    assert.equal(scan.inline, false);
    assert.equal(scan.unreadable, 0);
    assert.deepEqual(scan.names, []);
  });

  it('counts entries it cannot read a name from', () => {
    // Entries that are neither `- {name: ...}` nor `- name: ...`. Whatever
    // produced them, we must not proceed as though the block were empty.
    const yaml = ['proxies:', '  - A', '  - B', 'proxy-groups:', ''].join('\n');
    const scan = scanNodes(yaml);
    assert.equal(scan.unreadable, 2);
    assert.deepEqual(scan.names, []);
  });

  it('does not count a block-style node\'s continuation lines as unreadable', () => {
    const yaml = ['proxies:', '  - name: A', '    type: ss', '    server: x', '  - name: B'].join('\n');
    const scan = scanNodes(yaml);
    assert.equal(scan.unreadable, 0);
    assert.deepEqual(scan.names, ['A', 'B']);
  });

  it('reports nothing for a config with no proxies block', () => {
    const scan = scanNodes('port: 7890\nmode: Rule\n');
    assert.deepEqual(scan.names, []);
    assert.equal(scan.unreadable, 0);
    assert.equal(scan.inline, false);
  });

  it('stops at the next top-level key', () => {
    const yaml = ['proxies:', '  - {name: A}', 'proxy-groups:', '  - {name: G}'].join('\n');
    const scan = scanNodes(yaml);
    assert.deepEqual(scan.names, ['A']);
    assert.equal(scan.unreadable, 0);
  });
});

describe('scanGroups', () => {
  it('reads block-style groups', () => {
    const scan = scanGroups(SAMPLE);
    assert.deepEqual(scan.names, ['🔰 节点选择']);
    assert.equal(scan.inlineEntries, 0);
    assert.equal(scan.inline, false);
  });

  it('flags flow-style group entries, which is the dangerous case', () => {
    // Here the node references sit on the same line as the group, so a
    // rewrite that only handles `- <name>` lines would rename the nodes and
    // leave these pointing at the old names.
    const yaml = [
      'proxy-groups:',
      '  - {name: G, type: select, proxies: [HK-01, JP-01]}',
      '  - name: H',
      '    proxies:',
      '      - HK-01',
      '',
    ].join('\n');
    const scan = scanGroups(yaml);
    assert.equal(scan.inlineEntries, 1);
    assert.deepEqual(scan.names, ['H'], 'the block-style group is still read');
  });

  it('flags a single-line group block as inline', () => {
    const scan = scanGroups('proxy-groups: [{name: G, proxies: [A]}]\n');
    assert.equal(scan.inline, true);
  });

  it('is clean for an absent or empty block', () => {
    for (const yaml of ['port: 7890\n', 'proxy-groups: []\n']) {
      const scan = scanGroups(yaml);
      assert.equal(scan.inlineEntries, 0);
      assert.equal(scan.inline, false);
    }
  });
});

describe('extractNodeNames', () => {
  it('reads names in document order from flow style', () => {
    assert.deepEqual(extractNodeNames(SAMPLE), ['HK-01', 'HK-02', 'JP-01']);
  });

  it('reads block style too', () => {
    const yaml = ['proxies:', '  - name: A', '    type: ss', '  - name: B'].join('\n');
    assert.deepEqual(extractNodeNames(yaml), ['A', 'B']);
  });

  it('does not pick up group names or rules', () => {
    // The groups block has `- name:` lines and a list of bare names; neither
    // is a node.
    const names = extractNodeNames(SAMPLE);
    assert.ok(!names.includes('🔰 节点选择'));
    assert.ok(!names.includes('♻️ 自动选择'));
  });

  it('returns nothing for an empty or absent block', () => {
    assert.deepEqual(extractNodeNames('port: 7890\n'), []);
    assert.deepEqual(extractNodeNames('proxies: []\nproxy-groups: []\n'), []);
  });
});

describe('extractGroupNames', () => {
  it('reads group names, not their referenced nodes', () => {
    assert.deepEqual(extractGroupNames(SAMPLE), ['🔰 节点选择']);
  });

  it('stops at the next top-level key', () => {
    assert.deepEqual(extractGroupNames('proxy-groups:\n  - name: A\nrules:\n  - name: not-a-group\n'), [
      'A',
    ]);
  });
});

describe('buildPrefixPlan', () => {
  const nodeNames = ['HK-01', 'JP-01'];

  it('maps each node to its source prefix', () => {
    const plan = buildPrefixPlan(nodeNames, owners({ 'HK-01': ['机场甲'], 'JP-01': ['机场乙'] }), []);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.mapping.get('HK-01'), '[机场甲] HK-01');
    assert.equal(plan.mapping.get('JP-01'), '[机场乙] JP-01');
  });

  it('declines when two sources offer the same node name', () => {
    // There is no way to know which airport this node came from, so
    // attributing it to either would be inventing information.
    const plan = buildPrefixPlan(nodeNames, owners({ 'HK-01': ['甲', '乙'], 'JP-01': ['乙'] }), []);
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.reason, /exists in 2 sources/);
  });

  it('declines when a node has no known source', () => {
    const plan = buildPrefixPlan(nodeNames, owners({ 'HK-01': ['甲'] }), []);
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.reason, /JP-01/);
  });

  it('declines when a name is both a node and a group', () => {
    // A global string rewrite would rename the group too, and every reference
    // to it would break.
    const plan = buildPrefixPlan(['HK-01'], owners({ 'HK-01': ['甲'] }), ['HK-01']);
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.match(plan.reason, /both a node and a group/);
  });

  it('accepts an empty node list', () => {
    assert.equal(buildPrefixPlan([], owners({}), []).ok, true);
  });
});

describe('buildSourceGroups', () => {
  const bySource = (entries: Record<string, string[]>): Map<string, string[]> =>
    new Map(Object.entries(entries));

  /** A plain select group, which is what every test below starts from. */
  const SELECT: GroupSpec = { type: 'select', url: null, interval: 300, tolerance: 50 };
  const TESTED: GroupSpec = {
    type: 'url-test',
    url: 'http://probe.example.com/generate_204',
    interval: 500,
    tolerance: 200,
  };

  it('builds a group per source', () => {
    const result = buildSourceGroups(bySource({ 机场甲: ['[机场甲] HK-01', '[机场甲] JP-01'] }), [], SELECT);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.deepEqual(result.names, ['机场甲']);
    assert.match(result.yaml, /- name: "机场甲"/);
    assert.match(result.yaml, /type: select/);
    assert.match(result.yaml, /- "\[机场甲\] HK-01"/);
  });

  it('omits probe settings on a select group', () => {
    // They would be accepted but mean nothing, and would make the output
    // harder to read against what was configured.
    const result = buildSourceGroups(bySource({ 甲: ['node'] }), [], SELECT);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(!result.yaml.includes('interval:'), 'no interval on a select group');
    assert.ok(!result.yaml.includes('url:'), 'no probe url on a select group');
    assert.ok(!result.yaml.includes('tolerance:'), 'no tolerance on a select group');
  });

  it('emits probe settings for a testing type', () => {
    const result = buildSourceGroups(bySource({ 甲: ['[甲] HK-01'] }), [], TESTED);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.yaml, /type: url-test/);
    assert.match(result.yaml, /url: "http:\/\/probe\.example\.com\/generate_204"/);
    assert.match(result.yaml, /interval: 500/);
    assert.match(result.yaml, /tolerance: 200/);
  });

  it('omits the probe url when none was configured', () => {
    // Subconverter applies its own default; emitting `url: null` would not.
    const result = buildSourceGroups(bySource({ 甲: ['node'] }), [], { ...TESTED, url: null });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(!result.yaml.includes('url:'), 'no url line at all');
    assert.match(result.yaml, /interval: 500/, 'the other settings still apply');
  });

  it('quotes names, because a prefixed node always starts with a bracket', () => {
    // Unquoted, `- [机场甲] HK-01` parses as a nested YAML sequence rather than
    // a string. Subconverter quotes them for the same reason.
    const result = buildSourceGroups(bySource({ 甲: ['[甲] HK-01'] }), [], SELECT);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.yaml.includes('- "[甲] HK-01"'), 'the name must be quoted');
    assert.ok(!/\n\s+- \[甲\] HK-01\n/.test(result.yaml), 'and must not appear unquoted');
  });

  it('escapes quotes inside a name', () => {
    const result = buildSourceGroups(bySource({ 'a"b': ['node'] }), [], SELECT);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.yaml.includes('"a\\"b"'), 'inner quotes must be escaped');
  });

  it('refuses a name that collides with an existing group', () => {
    // Shadowing would silently replace the template's own group.
    const result = buildSourceGroups(bySource({ Proxy: ['node'] }), ['Proxy', '自动选择'], SELECT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /Proxy/);
  });

  it('skips a source that contributed no nodes', () => {
    const result = buildSourceGroups(bySource({ 甲: ['a'], 乙: [] }), [], SELECT);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.names, ['甲']);
    assert.ok(!result.yaml.includes('乙'));
  });

  it('refuses when nothing has any nodes', () => {
    const result = buildSourceGroups(bySource({ 甲: [] }), [], SELECT);
    assert.equal(result.ok, false);
  });
});

describe('appendToGroupSection', () => {
  const BLOCK = '  - name: "甲"\n    type: select\n    proxies:\n      - "[甲] HK-01"';

  it('appends at the end of the section, before the next top-level key', () => {
    const result = appendToGroupSection(SAMPLE, BLOCK);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const lines = result.content.split('\n');
    const added = lines.findIndex((l) => l.includes('- name: "甲"'));
    const rules = lines.findIndex((l) => l === 'rules:');
    assert.ok(added > 0 && added < rules, 'the block goes inside the section');
  });

  it('leaves every existing group untouched', () => {
    // The entire safety argument for this feature: nothing existing is
    // modified, so an unfamiliar group structure cannot be damaged.
    const result = appendToGroupSection(SAMPLE, BLOCK);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // Every original line is still present, in the same order...
    const before = SAMPLE.split('\n');
    const after = result.content.split('\n');
    let cursor = 0;
    for (const line of before) {
      const at = after.indexOf(line, cursor);
      assert.notEqual(at, -1, `line disappeared: ${JSON.stringify(line)}`);
      cursor = at + 1;
    }

    // ...and the block is the only thing that was added.
    assert.equal(after.length, before.length + BLOCK.split('\n').length);
  });

  it('refuses when the config has no group section', () => {
    const result = appendToGroupSection('proxies:\n  - {name: A}\n', BLOCK);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /no proxy-groups/);
  });

  it('handles a group section that runs to the end of the document', () => {
    const yaml = 'proxies:\n  - {name: A}\nproxy-groups:\n  - name: G\n    type: select\n';
    const result = appendToGroupSection(yaml, BLOCK);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.content.includes('- name: "甲"'));
    assert.ok(result.content.indexOf('- name: "甲"') > result.content.indexOf('- name: G'));
  });
});

describe('applyNodePrefix', () => {
  const mapping = new Map([
    ['HK-01', prefixFor('机场甲') + 'HK-01'],
    ['HK-02', prefixFor('机场甲') + 'HK-02'],
    ['JP-01', prefixFor('机场乙') + 'JP-01'],
  ]);

  it('rewrites the name field in the proxies block', () => {
    const out = applyNodePrefix(SAMPLE, mapping);
    assert.ok(out.includes('name: [机场甲] HK-01,'));
    assert.ok(out.includes('name: [机场乙] JP-01,'));
  });

  it('rewrites the group references too', () => {
    // The whole point: without this the groups point at names that no longer
    // exist, and the config is broken without any error.
    const out = applyNodePrefix(SAMPLE, mapping);
    assert.ok(out.includes('\n      - [机场甲] HK-01'));
    assert.ok(out.includes('\n      - [机场乙] JP-01'));
  });

  it('keeps every name consistent between the two places', () => {
    const out = applyNodePrefix(SAMPLE, mapping);
    for (const renamed of mapping.values()) {
      const occurrences = out.split(renamed).length - 1;
      // once as the node definition, once in the group list
      assert.equal(occurrences, 2, `${renamed} should appear twice, found ${occurrences}`);
    }
  });

  it('leaves group names, built-in policies and rules untouched', () => {
    const out = applyNodePrefix(SAMPLE, mapping);
    assert.ok(out.includes('- name: 🔰 节点选择'));
    assert.ok(out.includes('- ♻️ 自动选择'));
    assert.ok(out.includes('- 🎯 全球直连'));
    assert.ok(out.includes('- MATCH,🔰 节点选择'));
  });

  it('does not confuse a name with a longer name containing it', () => {
    // HK-01 and HK-011 must not corrupt each other - the reason this is not a
    // global string replace.
    const yaml = [
      'proxies:',
      '  - {name: HK-01, server: a, port: 1}',
      '  - {name: HK-011, server: b, port: 2}',
      'proxy-groups:',
      '  - name: G',
      '    proxies:',
      '      - HK-01',
      '      - HK-011',
      '',
    ].join('\n');
    const out = applyNodePrefix(yaml, new Map([['HK-01', '[甲] HK-01']]));

    assert.ok(out.includes('name: [甲] HK-01,'));
    assert.ok(out.includes('name: HK-011,'), 'the longer name must be untouched');
    assert.ok(out.includes('\n      - [甲] HK-01'));
    assert.ok(out.includes('\n      - HK-011'));
  });

  it('leaves a name it has no plan for untouched', () => {
    const yaml = 'proxies:\n  - {name: OTHER, server: a, port: 1}\n';
    assert.equal(applyNodePrefix(yaml, mapping), yaml);
  });

  it('is a no-op for an empty mapping', () => {
    assert.equal(applyNodePrefix(SAMPLE, new Map()), SAMPLE);
  });

  it('preserves everything else byte for byte', () => {
    const out = applyNodePrefix(SAMPLE, mapping);
    const stripped = out
      .split('\n')
      .map((l) => l.replace(/\[机场[甲乙]\] /g, ''))
      .join('\n');
    assert.equal(stripped, SAMPLE);
  });
});
