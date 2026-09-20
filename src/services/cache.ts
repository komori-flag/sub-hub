/* ------------------------------------------------------------------ *
 * Primitives for bounding how much work reaches Subconverter.
 *
 * All three are per-process and in-memory. That is the right scope for the
 * problem - one Subconverter fan-out per client refresh - and it means there
 * is nothing to configure, nothing to connect to, and nothing to go stale
 * across a restart. If you run more than one app replica each gets its own
 * set, which is fine: it degrades to "each replica does its own bounded
 * work" rather than being wrong.
 * ------------------------------------------------------------------ */

/**
 * A small TTL + LRU cache.
 */
export class TtlLruCache<K, V> {
  readonly #map = new Map<K, { value: V; expiresAt: number; bytes: number }>();
  #bytes = 0;
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly sizeOf: (value: V) => number,
  ) {}

  get(key: K): V | undefined {
    const entry = this.#map.get(key);
    if (entry === undefined) {
      this.#misses++;
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.#map.delete(key);
      this.#bytes -= entry.bytes;
      this.#misses++;
      return undefined;
    }

    // Re-insert so Map's insertion order tracks recency, which is what makes
    // #evict() an LRU rather than a FIFO.
    this.#map.delete(key);
    this.#map.set(key, entry);
    this.#hits++;
    return entry.value;
  }

  set(key: K, value: V): void {
    const bytes = this.sizeOf(value);

    // An entry bigger than the entire budget would evict everything and still
    // not fit, so refuse it instead of thrashing the cache.
    if (bytes > this.maxBytes) return;

    const existing = this.#map.get(key);
    if (existing !== undefined) {
      this.#map.delete(key);
      this.#bytes -= existing.bytes;
    }

    this.#map.set(key, { value, expiresAt: Date.now() + this.ttlMs, bytes });
    this.#bytes += bytes;
    this.#evict();
  }

  #evict(): void {
    while (this.#map.size > this.maxEntries || this.#bytes > this.maxBytes) {
      const oldest = this.#map.keys().next();
      if (oldest.done === true) break;

      const entry = this.#map.get(oldest.value);
      this.#map.delete(oldest.value);
      if (entry !== undefined) this.#bytes -= entry.bytes;
      this.#evictions++;
    }
  }

  get stats(): { entries: number; bytes: number; hits: number; misses: number; evictions: number } {
    return {
      entries: this.#map.size,
      bytes: this.#bytes,
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
    };
  }

  clear(): void {
    this.#map.clear();
    this.#bytes = 0;
  }
}

/**
 * Collapses concurrent calls for the same key into one execution.
 *
 * This is the half of the caching story that actually matters for the failure
 * mode being fixed: a TTL cache does nothing when N clients all refresh at the
 * same moment with a cold cache, because all N miss before any of them
 * finishes. Single-flight turns that burst into exactly one Subconverter
 * fan-out, and every waiter gets that result.
 */
export interface FlightResult<V> {
  promise: Promise<V>;
  /**
   * true when this caller attached to an already-running execution instead of
   * starting one. Reported separately from a cache hit so the two are
   * distinguishable in logs - they mean very different things operationally.
   */
  joined: boolean;
}

export class SingleFlight<K, V> {
  readonly #inflight = new Map<K, Promise<V>>();

  run(key: K, produce: () => Promise<V>): FlightResult<V> {
    const existing = this.#inflight.get(key);
    if (existing !== undefined) return { promise: existing, joined: true };

    const promise = produce().finally(() => {
      this.#inflight.delete(key);
    });

    this.#inflight.set(key, promise);
    return { promise, joined: false };
  }

  get size(): number {
    return this.#inflight.size;
  }
}

export class SemaphoreBusyError extends Error {
  constructor(readonly reason: 'queue_full' | 'timeout') {
    super(reason === 'queue_full' ? 'too many conversions already queued' : 'timed out waiting for a conversion slot');
    this.name = 'SemaphoreBusyError';
  }
}

/**
 * Bounds how many conversions run at once, with a bounded wait queue.
 *
 * The queue being finite is the point: unbounded queueing under sustained
 * overload is just a slower way to hang, and it grows latency without
 * shedding any load. Rejecting once the queue is full turns overload into a
 * fast, legible 503 that a client can retry, which is strictly better than a
 * timeout it waited 20 seconds for.
 */
export class Semaphore {
  #active = 0;
  readonly #queue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueue: number,
    private readonly acquireTimeoutMs: number,
  ) {}

  async acquire(): Promise<void> {
    if (this.#active < this.maxConcurrent) {
      this.#active++;
      return;
    }

    if (this.#queue.length >= this.maxQueue) {
      throw new SemaphoreBusyError('queue_full');
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Give up the place rather than staying queued for a slot we will
        // never wait around for.
        const index = this.#queue.findIndex((entry) => entry.timer === timer);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(new SemaphoreBusyError('timeout'));
      }, this.acquireTimeoutMs);

      this.#queue.push({ resolve, reject, timer });
    });
  }

  release(): void {
    const next = this.#queue.shift();
    if (next !== undefined) {
      // Hand the slot straight to the next waiter: #active is unchanged
      // because the slot never became free.
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    this.#active--;
  }

  get stats(): { active: number; queued: number; maxConcurrent: number; maxQueue: number } {
    return {
      active: this.#active,
      queued: this.#queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueue: this.maxQueue,
    };
  }
}
