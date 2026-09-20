// Must come first - see test/setup.ts.
import './setup.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SOURCE_SEPARATOR,
  buildSourceUrlParam,
  buildSubconverterUrl,
} from '../src/services/converter.js';
import { parseSourceIds } from '../src/db.js';

const BASE = 'http://subconverter:25500';

const A = 'https://a.example.com/sub?token=abc';
const B = 'https://b.example.com/sub?clash=vmess';

describe('buildSourceUrlParam', () => {
  it('fully encodes a single source url', () => {
    assert.equal(buildSourceUrlParam([A]), encodeURIComponent(A));
  });

  it('joins multiple sources with an encoded pipe', () => {
    assert.equal(buildSourceUrlParam([A, B]), encodeURIComponent(A) + '%7C' + encodeURIComponent(B));
    assert.equal(SOURCE_SEPARATOR, '%7C');
    assert.ok(!buildSourceUrlParam([A, B]).includes('|'), 'must not emit a raw pipe');
  });

  it('is exactly equivalent to encoding the joined string', () => {
    // This identity is why "join first, then encode the whole thing" (the
    // documented rule) and "encode each, join with %7C" (what we do) agree.
    assert.equal(buildSourceUrlParam([A, B]), encodeURIComponent([A, B].join('|')));
  });

  it('never double-encodes', () => {
    // %25 is the signature of a '%' encoded twice. cpp-httplib decodes once,
    // so Subconverter would receive the literal string "https%3A%2F%2F..."
    // and fail to fetch it - surfacing as HTTP 200 with an empty config.
    const built = buildSourceUrlParam([A, B]);
    assert.ok(!built.includes('%25'), 'no double-encoding');
    assert.ok(built.startsWith('https%3A%2F%2F'), 'scheme encoded exactly once');
  });

  it('escapes + as %2B', () => {
    // cpp-httplib maps '+' in a decoded query value to a space, so a literal
    // '+' in an opaque token would silently corrupt the upstream fetch.
    const withPlus = 'https://c.example.com/sub?token=ab+cd';
    assert.ok(buildSourceUrlParam([withPlus]).includes('%2B'));
    assert.ok(!buildSourceUrlParam([withPlus]).includes('+'));
  });

  it('escapes & so it cannot break out of the url parameter', () => {
    assert.ok(!buildSourceUrlParam([A]).includes('&'));
  });
});

describe('buildSubconverterUrl', () => {
  const base = { target: 'clash', sourceUrls: [A, B], udp: true };

  it('builds the expected query', () => {
    assert.equal(
      buildSubconverterUrl(BASE, base),
      `${BASE}/sub?target=clash&url=${buildSourceUrlParam([A, B])}&udp=true`,
    );
  });

  it('renders udp=false when disabled', () => {
    assert.ok(buildSubconverterUrl(BASE, { ...base, udp: false }).includes('&udp=false'));
  });

  it('omits config and exclude when unset or empty', () => {
    for (const req of [base, { ...base, customRuleset: '', excludeRemarks: '' }]) {
      const url = buildSubconverterUrl(BASE, req);
      assert.ok(!url.includes('config='));
      assert.ok(!url.includes('exclude='));
    }
  });

  it('omits the token when unset or empty', () => {
    for (const req of [base, { ...base, token: '' }]) {
      assert.ok(!buildSubconverterUrl(BASE, req).includes('token='));
    }
  });

  it('appends and encodes the token when set', () => {
    // Needed when the backend runs with api_mode=true / api_access_token.
    const token = 'p@ss word&x';
    const url = buildSubconverterUrl(BASE, { ...base, token });
    assert.ok(url.includes(`token=${encodeURIComponent(token)}`));

    // A raw '&' or space in the token would split the query and hand the
    // backend a truncated token, so count the parameters rather than trusting
    // the encoding by eye.
    const query = url.slice(url.indexOf('?') + 1);
    assert.ok(!query.includes(' '), 'the space must be encoded');
    assert.equal(query.split('&').length, 4, 'exactly target, url, udp, token - no split');
  });

  it('includes and encodes config and exclude when set', () => {
    const ruleset = 'https://rules.example.com/my.ini';
    const url = buildSubconverterUrl(BASE, {
      ...base,
      customRuleset: ruleset,
      excludeRemarks: '测试|TEST-.*',
    });
    assert.ok(url.includes(`config=${encodeURIComponent(ruleset)}`));
    assert.ok(url.includes(`exclude=${encodeURIComponent('测试|TEST-.*')}`));
  });
});

describe('parseSourceIds', () => {
  it('parses a well-formed array', () => {
    assert.deepEqual(parseSourceIds('["sub_01","sub_02"]'), { ids: ['sub_01', 'sub_02'], valid: true });
  });

  it('fails safe on malformed input instead of throwing', () => {
    // A corrupted row must not 500 every request for that profile forever.
    for (const bad of ['not json', '{oops', '{"a":1}', 'null', '123', '', null, undefined]) {
      const result = parseSourceIds(bad);
      assert.equal(result.valid, false, `expected invalid for ${JSON.stringify(bad)}`);
      assert.deepEqual(result.ids, []);
    }
  });

  it('keeps the good entries from a partially bad array but flags it', () => {
    assert.deepEqual(parseSourceIds('["sub_01", 42]'), { ids: ['sub_01'], valid: false });
  });
});
