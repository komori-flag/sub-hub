// Must come first - see test/setup.ts.
import './setup.js';

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { Semaphore, SemaphoreBusyError, SingleFlight, TtlLruCache } from '../src/services/cache.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sizeOf = (value: string) => value.length;

describe('TtlLruCache', () => {
  it('returns undefined for a missing key and counts a miss', () => {
    const cache = new TtlLruCache<string, string>(1000, 10, 1000, sizeOf);
    assert.equal(cache.get('nope'), undefined);
    assert.equal(cache.stats.misses, 1);
    assert.equal(cache.stats.hits, 0);
  });

  it('stores and retrieves a value', () => {
    const cache = new TtlLruCache<string, string>(1000, 10, 1000, sizeOf);
    cache.set('k', 'v');
    assert.equal(cache.get('k'), 'v');
    assert.equal(cache.stats.hits, 1);
    assert.equal(cache.stats.entries, 1);
  });

  it('expires an entry once the TTL has passed', async () => {
    const cache = new TtlLruCache<string, string>(40, 10, 1000, sizeOf);
    cache.set('k', 'v');
    assert.equal(cache.get('k'), 'v');

    await sleep(80);
    assert.equal(cache.get('k'), undefined);
    assert.equal(cache.stats.entries, 0, 'expired entry is dropped, not just hidden');
    assert.equal(cache.stats.bytes, 0);
  });

  it('evicts the least recently used entry when over the entry cap', () => {
    const cache = new TtlLruCache<string, string>(10_000, 2, 1000, sizeOf);
    cache.set('a', '1');
    cache.set('b', '2');

    // Touching 'a' must make it the most recently used, so 'b' is the victim.
    assert.equal(cache.get('a'), '1');
    cache.set('c', '3');

    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a'), '1');
    assert.equal(cache.get('c'), '3');
    assert.equal(cache.stats.evictions, 1);
  });

  it('evicts when over the byte budget and keeps the accounting exact', () => {
    const cache = new TtlLruCache<string, string>(10_000, 100, 10, sizeOf);
    cache.set('a', '12345');
    cache.set('b', '12345');
    assert.equal(cache.stats.bytes, 10);

    cache.set('c', '12345'); // would be 15 > 10, so 'a' goes
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), '12345');
    assert.equal(cache.get('c'), '12345');
    assert.equal(cache.stats.bytes, 10);
  });

  it('refuses an entry larger than the entire budget without evicting anything', () => {
    const cache = new TtlLruCache<string, string>(10_000, 100, 10, sizeOf);
    cache.set('a', '12345');

    cache.set('huge', 'x'.repeat(50));
    assert.equal(cache.get('huge'), undefined);
    assert.equal(cache.get('a'), '12345', 'the existing entry survived');
    assert.equal(cache.stats.evictions, 0);
  });

  it('does not double-count bytes when a key is overwritten', () => {
    const cache = new TtlLruCache<string, string>(10_000, 100, 1000, sizeOf);
    cache.set('k', '12345');
    cache.set('k', '1234567890');
    assert.equal(cache.stats.entries, 1);
    assert.equal(cache.stats.bytes, 10);
  });
});

describe('SingleFlight', () => {
  it('runs the producer exactly once for concurrent callers on one key', async () => {
    const flight = new SingleFlight<string, number>();
    let calls = 0;
    const produce = async () => {
      calls++;
      await sleep(20);
      return 42;
    };

    const first = flight.run('k', produce);
    const second = flight.run('k', produce);
    const third = flight.run('k', produce);

    assert.equal(first.joined, false, 'the first caller leads');
    assert.equal(second.joined, true, 'the rest attach to it');
    assert.equal(third.joined, true);

    const results = await Promise.all([first.promise, second.promise, third.promise]);
    assert.equal(calls, 1, 'three callers must collapse into one upstream call');
    assert.deepEqual(results, [42, 42, 42]);
  });

  it('does not collapse different keys', async () => {
    const flight = new SingleFlight<string, string>();
    let calls = 0;
    const produce = async () => {
      calls++;
      await sleep(10);
      return 'x';
    };

    const a = flight.run('a', produce);
    const b = flight.run('b', produce);
    assert.equal(a.joined, false);
    assert.equal(b.joined, false);

    await Promise.all([a.promise, b.promise]);
    assert.equal(calls, 2);
  });

  it('clears the key after completion so the next call runs again', async () => {
    const flight = new SingleFlight<string, number>();
    let calls = 0;
    const produce = async () => ++calls;

    assert.equal(await flight.run('k', produce).promise, 1);
    assert.equal(flight.size, 0);
    assert.equal(await flight.run('k', produce).promise, 2);
  });

  it('propagates rejection to every waiter, clears the key, and retries next time', async () => {
    const flight = new SingleFlight<string, number>();
    let calls = 0;
    const failing = async () => {
      calls++;
      await sleep(10);
      throw new Error('upstream down');
    };

    const results = await Promise.allSettled([
      flight.run('k', failing).promise,
      flight.run('k', failing).promise,
    ]);
    assert.equal(calls, 1);
    assert.ok(
      results.every((r) => r.status === 'rejected'),
      'every waiter sees the failure',
    );
    assert.equal(flight.size, 0);
    assert.equal(
      await flight.run('k', async () => 7).promise,
      7,
      'a later call is not poisoned by the earlier failure',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Integration: does getConvertedConfig actually stop the fan-out?
 *
 * This is the behaviour the cache exists for, so it is tested against a real
 * HTTP server rather than a mock. The upstream is started on an ephemeral
 * port BEFORE config.ts is imported, because config reads SUBCONVERTER_URL
 * exactly once at module-evaluation time.
 * ------------------------------------------------------------------ */

let upstreamHits = 0;
let upstreamMode: 'ok' | 'fail' = 'ok';
let upstreamDelayMs = 0;
let lastUpstreamUrl = '';

const upstream = createServer((req, res) => {
  upstreamHits++;
  lastUpstreamUrl = req.url ?? '';
  const respond = () => {
    if (upstreamMode === 'fail') {
      res.statusCode = 500;
      res.end('boom');
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('proxies: []\n');
  };
  if (upstreamDelayMs > 0) setTimeout(respond, upstreamDelayMs);
  else respond();
});

await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = (upstream.address() as AddressInfo).port;
process.env.SUBCONVERTER_URL = `http://127.0.0.1:${upstreamPort}`;

// Dynamic import: config.ts reads the environment when it is first evaluated,
// so it must not happen until the line above has run.
const { getConvertedConfig, converterStats } = await import('../src/services/converter.js');

after(() => {
  upstream.close();
});

const request = (userAgent: string, url = 'https://a.example.com/sub', token?: string) => ({
  target: 'clash',
  sourceUrls: [url],
  customRuleset: null,
  excludeRemarks: null,
  udp: true,
  userAgent,
  ...(token === undefined ? {} : { token }),
});

describe('getConvertedConfig caching', () => {
  it('serves the second identical request from cache', async () => {
    upstreamHits = 0;
    upstreamMode = 'ok';

    const first = await getConvertedConfig(request('clash-verge/v1'));
    const second = await getConvertedConfig(request('clash-verge/v1'));

    assert.equal(first.source, 'fetch');
    assert.equal(second.source, 'cache');
    assert.equal(upstreamHits, 1, 'the upstream must be hit once, not twice');
    assert.equal(second.result.body.byteLength, first.result.body.byteLength);
  });

  // This test doubles as proof that the semaphore sits inside the
  // single-flight closure: with MAX_CONCURRENT_CONVERSIONS=1 and a queue of 8,
  // ten joiners acquiring slots individually would shed two of them with
  // SERVER_BUSY. They all succeed, so only the leader took a slot.
  it('collapses a concurrent burst into a single upstream call', async () => {
    upstreamHits = 0;
    upstreamMode = 'ok';
    upstreamDelayMs = 40;

    const results = await Promise.all(
      Array.from({ length: 10 }, () => getConvertedConfig(request('clash-verge/v2'))),
    );

    upstreamDelayMs = 0;
    assert.equal(upstreamHits, 1, 'ten simultaneous cold requests must cause one fan-out');
    assert.ok(
      results.every((r) => r.result.body.byteLength > 0),
      'every waiter still gets the body',
    );
    assert.equal(results.filter((r) => r.source === 'fetch').length, 1, 'exactly one leader');
    assert.equal(
      results.filter((r) => r.source === 'coalesced').length,
      9,
      'the other nine attach to the in-flight request rather than waiting for the cache',
    );
  });

  it('sheds load with SERVER_BUSY once the bounded queue is full', async () => {
    upstreamHits = 0;
    upstreamMode = 'ok';
    upstreamDelayMs = 150;

    // Ten DISTINCT keys, so single-flight cannot merge them: every one is a
    // separate conversion competing for a slot.
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        getConvertedConfig(request('ua-shed/1.0', `https://src.example.com/${i}`)),
      ),
    );

    upstreamDelayMs = 0;

    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    const rejected = attempts.filter((a) => a.status === 'rejected');

    // maxConcurrent=1 with a derived queue of 8 (see test/setup.ts): one runs,
    // eight wait their turn, and the tenth is shed rather than queued.
    assert.equal(fulfilled.length, 9);
    assert.equal(rejected.length, 1);

    const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string; status?: number };
    assert.equal(reason.code, 'SERVER_BUSY');
    assert.equal(reason.status, 503);
    assert.equal(upstreamHits, 9, 'the shed request never reached the upstream');
  });

  it('does NOT include the backend token in the cache key', async () => {
    upstreamHits = 0;
    upstreamMode = 'ok';

    // The token is a credential, not an input that changes the generated
    // config. If it were part of the key, rotating the token would silently
    // throw away the whole cache.
    await getConvertedConfig(request('ua-token/1.0', 'https://tok.example.com/s', 'secret-a'));
    const second = await getConvertedConfig(
      request('ua-token/1.0', 'https://tok.example.com/s', 'secret-b'),
    );

    assert.equal(upstreamHits, 1, 'a different token must still hit the same cache entry');
    assert.equal(second.source, 'cache');
  });

  it('carries SUBCONVERTER_TOKEN from config all the way to the upstream', async () => {
    // Exercises the real wiring - requestForProfile reads config, the URL
    // builder appends the param, and the fetch sends it - rather than
    // asserting on a hand-built URL.
    const { requestForProfile } = await import('../src/services/converter.js');

    upstreamHits = 0;
    upstreamMode = 'ok';
    lastUpstreamUrl = '';

    const profile = {
      key: 'tok',
      target: 'clash',
      sourceIds: ['sub_01'],
      sourceIdsValid: true,
      customRuleset: null,
      excludeRemarks: null,
      udp: true,
      createdAt: '2026-01-01 00:00:00',
    };

    await getConvertedConfig(requestForProfile(profile, ['https://a.example.com/sub'], 'ua/1.0'));

    assert.equal(upstreamHits, 1);
    assert.ok(
      lastUpstreamUrl.includes('token=test-backend-token'),
      `upstream saw: ${lastUpstreamUrl}`,
    );
  });

  it('keys on the User-Agent', async () => {
    upstreamHits = 0;
    upstreamMode = 'ok';

    await getConvertedConfig(request('ua-one/1.0'));
    await getConvertedConfig(request('ua-two/1.0'));

    // The UA is forwarded upstream and providers gate on it, so two different
    // clients must not share a cached body.
    assert.equal(upstreamHits, 2);
  });

  it('does not cache failures', async () => {
    upstreamHits = 0;
    upstreamMode = 'fail';

    await assert.rejects(() => getConvertedConfig(request('ua-flaky/1.0')), /subconverter responded 500/);
    assert.equal(upstreamHits, 1);

    // Caching the 502 would turn a Subconverter restart into a TTL-long outage.
    upstreamMode = 'ok';
    const retry = await getConvertedConfig(request('ua-flaky/1.0'));
    assert.equal(retry.source, 'fetch');
    assert.equal(upstreamHits, 2);
  });

  it('bypassCache forces a fresh conversion', async () => {
    upstreamHits = 0;
    upstreamMode = 'ok';

    await getConvertedConfig(request('ua-bypass/1.0'));
    const forced = await getConvertedConfig(request('ua-bypass/1.0'), { bypassCache: true });

    assert.equal(forced.source, 'fetch');
    assert.equal(upstreamHits, 2);
  });

  it('reports stats that reflect the caching above', () => {
    const stats = converterStats();
    assert.equal(stats.cache.enabled, true);
    assert.equal(stats.cache.ttlMs, 90_000);
    assert.ok(stats.cache.hits > 0, 'there were cache hits');
    assert.ok(stats.cache.entries > 0, 'entries are being held');
    assert.equal(stats.concurrency.active, 0, 'nothing is still running');
    assert.equal(stats.concurrency.queued, 0);
  });
});

describe('Semaphore', () => {
  it('admits up to maxConcurrent without queueing', async () => {
    const sem = new Semaphore(2, 4, 1000);
    await sem.acquire();
    await sem.acquire();

    assert.equal(sem.stats.active, 2);
    assert.equal(sem.stats.queued, 0);

    // The third has to wait for a slot, so it must not resolve on its own.
    let admitted = false;
    const third = sem.acquire().then(() => {
      admitted = true;
    });
    await sleep(10);
    assert.equal(admitted, false, 'the third caller is held');
    assert.equal(sem.stats.queued, 1);

    sem.release();
    await third;
    assert.equal(admitted, true);
    assert.equal(sem.stats.active, 2, 'the slot transferred, it did not open up');

    sem.release();
    sem.release();
    assert.equal(sem.stats.active, 0);
  });

  it('hands queued waiters their turn in FIFO order', async () => {
    const sem = new Semaphore(1, 4, 1000);
    await sem.acquire();

    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) =>
      sem.acquire().then(() => {
        order.push(n);
        sem.release();
      }),
    );

    sem.release();
    await Promise.all(waiters);
    assert.deepEqual(order, [1, 2, 3]);
  });

  it('rejects when the queue is full instead of queueing without bound', async () => {
    const sem = new Semaphore(1, 1, 1000);
    await sem.acquire();

    const queued = sem.acquire(); // fills the single queue slot
    await sleep(5);

    await assert.rejects(
      () => sem.acquire(),
      (err: unknown) => err instanceof SemaphoreBusyError && err.reason === 'queue_full',
    );

    sem.release();
    await queued;
    sem.release();
  });

  it('rejects a waiter that cannot get a slot before the acquire timeout', async () => {
    const sem = new Semaphore(1, 4, 30);
    await sem.acquire();

    await assert.rejects(
      () => sem.acquire(),
      (err: unknown) => err instanceof SemaphoreBusyError && err.reason === 'timeout',
    );
    assert.equal(sem.stats.queued, 0, 'the timed-out waiter left the queue');

    // And the slot is still usable afterwards.
    sem.release();
    await sem.acquire();
    assert.equal(sem.stats.active, 1);
    sem.release();
  });

  it('does not leak a slot when the holder throws', async () => {
    const sem = new Semaphore(1, 1, 1000);

    const run = async () => {
      await sem.acquire();
      try {
        throw new Error('conversion failed');
      } finally {
        sem.release();
      }
    };

    await assert.rejects(run, /conversion failed/);
    assert.equal(sem.stats.active, 0, 'the slot came back');
    assert.equal(sem.stats.queued, 0);

    // Proof it is genuinely reusable, not just reported as free.
    await sem.acquire();
    assert.equal(sem.stats.active, 1);
    sem.release();
  });
});
