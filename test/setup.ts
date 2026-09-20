/*
 * Imported FIRST by every test file.
 *
 * config.ts validates the environment and calls process.exit(1) on a bad
 * configuration, and it runs the moment anything imports it - including
 * src/services/converter.ts and src/db.ts. ES modules are evaluated in import
 * order, so an `import './setup.js'` placed above the others guarantees this
 * has run first and the tests see a valid environment.
 *
 * DATABASE_PATH=:memory: also keeps the suite from creating a real file:
 * importing db.ts opens the database as a side effect.
 */
process.env.ADMIN_TOKEN ??= 'test-token-0123456789abcdef';
process.env.SUBCONVERTER_URL ??= 'http://subconverter.invalid:25500';
process.env.DATABASE_PATH = ':memory:';

// Pinned rather than left to the default so the cache tests assert a known
// value even if the developer's own .env sets something else. (Values already
// present in the environment win over .env, which is what makes this work.)
process.env.CACHE_TTL_MS = '90000';

// Deliberately 1, so the derived queue is 8. That makes the concurrency tests
// sharp: ten concurrent requests for ONE key can only all succeed if
// single-flight joiners do not each consume a slot, and ten requests for TEN
// keys must shed exactly one with SERVER_BUSY.
process.env.MAX_CONCURRENT_CONVERSIONS = '1';

// Set so the wiring from config -> request -> upstream URL is exercised.
// An empty value would silently skip the `&token=` param and the test that
// asserts it would pass for the wrong reason.
process.env.SUBCONVERTER_TOKEN = 'test-backend-token';
