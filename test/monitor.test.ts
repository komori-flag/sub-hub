// Must come first - see test/setup.ts.
import './setup.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { countNodes, levelFor, parseUserinfo } from '../src/services/monitor.js';
import type { SourceCheck } from '../src/types.js';

describe('countNodes', () => {
  it('counts entries in the proxies block', () => {
    const yaml = [
      'port: 7890',
      'proxies:',
      '  - {name: A, server: a.example.com, port: 1}',
      '  - {name: B, server: b.example.com, port: 2}',
      '  - {name: C, server: c.example.com, port: 3}',
      'proxy-groups:',
      '  - name: Proxy',
      '    type: select',
    ].join('\n');
    assert.equal(countNodes(yaml), 3);
  });

  it('does not count proxy-groups or rules as nodes', () => {
    // Both are indented dash entries too. Only the section matters.
    const yaml = [
      'proxies:',
      '  - {name: A}',
      'proxy-groups:',
      '  - name: Auto',
      '    proxies:',
      '      - A',
      'rules:',
      '  - DOMAIN-SUFFIX,example.com,DIRECT',
    ].join('\n');
    assert.equal(countNodes(yaml), 1);
  });

  it('returns 0 for an empty flow-style list', () => {
    assert.equal(countNodes('port: 7890\nproxies: []\nproxy-groups: []\n'), 0);
  });

  it('returns 0 when there is no proxies section at all', () => {
    assert.equal(countNodes('port: 7890\nmode: Rule\n'), 0);
  });

  it('returns 0 for an empty document', () => {
    assert.equal(countNodes(''), 0);
  });

  it('stops at the end of the section, not the end of the document', () => {
    // A blank line inside the block must not terminate it, and a later
    // top-level `proxies:`-looking string must not be picked up.
    const yaml = [
      'proxies:',
      '  - {name: A}',
      '',
      '  - {name: B}',
      'rule-providers:',
      '  x:',
      '    url: http://example.com/proxies:',
    ].join('\n');
    assert.equal(countNodes(yaml), 2);
  });

  it('counts block-style entries as well as flow-style', () => {
    const yaml = ['proxies:', '  - name: A', '    type: ss', '  - name: B'].join('\n');
    assert.equal(countNodes(yaml), 2);
  });
});

describe('parseUserinfo', () => {
  it('parses a full header', () => {
    assert.deepEqual(
      parseUserinfo('upload=171751; download=13343224; total=107374182400; expire=1794057373'),
      { upload: 171751, download: 13343224, total: 107374182400, expire: 1794057373 },
    );
  });

  it('returns all nulls for a missing header', () => {
    assert.deepEqual(parseUserinfo(null), {
      upload: null,
      download: null,
      total: null,
      expire: null,
    });
  });

  it('returns all nulls for an empty or blank header', () => {
    for (const header of ['', '   ']) {
      assert.deepEqual(parseUserinfo(header), {
        upload: null,
        download: null,
        total: null,
        expire: null,
      });
    }
  });

  it('leaves absent fields null rather than defaulting them to 0', () => {
    // A provider reporting no quota is not the same as one reporting zero
    // bytes left, and levelFor treats the two differently.
    assert.deepEqual(parseUserinfo('total=100'), {
      upload: null,
      download: null,
      total: 100,
      expire: null,
    });
  });

  it('tolerates extra whitespace and missing semicolons', () => {
    assert.deepEqual(parseUserinfo('upload = 5,  download=6'), {
      upload: 5,
      download: 6,
      total: null,
      expire: null,
    });
  });

  it('does not confuse download with load or upload', () => {
    assert.deepEqual(parseUserinfo('upload=1; download=2'), {
      upload: 1,
      download: 2,
      total: null,
      expire: null,
    });
  });
});

function check(overrides: Partial<SourceCheck> = {}): SourceCheck {
  return {
    sourceId: 'sub_a',
    checkedAt: '2026-01-01 00:00:00',
    ok: true,
    nodeCount: 10,
    upload: 0,
    download: 0,
    total: 100 * 1024 ** 3,
    expire: null,
    httpStatus: 200,
    error: null,
    latencyMs: 100,
    ...overrides,
  };
}

describe('levelFor', () => {
  const now = Date.UTC(2026, 0, 1);
  const nowSeconds = Math.floor(now / 1000);
  const days = (n: number): number => nowSeconds + n * 86_400;

  it('is ok for a healthy source', () => {
    assert.equal(levelFor(check({ expire: days(90) }), now), 'ok');
  });

  it('is error when the check itself failed', () => {
    assert.equal(levelFor(check({ ok: false, nodeCount: null, error: 'boom' }), now), 'error');
  });

  it('is error when the source converts but yields no nodes', () => {
    // This is the "subscription silently went empty" case, and it has to be
    // loud - a 0 here is indistinguishable from a parsing failure.
    assert.equal(levelFor(check({ nodeCount: 0 }), now), 'error');
  });

  it('is error once expired, including exactly at the expiry second', () => {
    assert.equal(levelFor(check({ expire: days(-1) }), now), 'error');
    assert.equal(levelFor(check({ expire: nowSeconds }), now), 'error');
  });

  it('is warn within the expiry warning window', () => {
    assert.equal(levelFor(check({ expire: days(7) }), now), 'warn');
    assert.equal(levelFor(check({ expire: days(1) }), now), 'warn');
  });

  it('is ok just outside the expiry warning window', () => {
    assert.equal(levelFor(check({ expire: days(8) }), now), 'ok');
  });

  it('is warn when the quota is nearly used up', () => {
    const total = 100 * 1024 ** 3;
    assert.equal(levelFor(check({ total, upload: 50, download: total - 50 }), now), 'warn');
  });

  it('is ok below the quota threshold', () => {
    const total = 100 * 1024 ** 3;
    assert.equal(levelFor(check({ total, upload: 0, download: total / 2 }), now), 'ok');
  });

  it('ignores quota when the provider reports none', () => {
    // total null means "no traffic metadata", not "no quota left".
    assert.equal(levelFor(check({ total: null, upload: null, download: null }), now), 'ok');
  });

  it('reports the most severe condition when several apply', () => {
    // Expired AND nearly out of quota must be error, not warn.
    const total = 100 * 1024 ** 3;
    assert.equal(
      levelFor(check({ total, download: total, expire: days(-5) }), now),
      'error',
    );
  });
});
