import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { config } from '../config.js';

/**
 * Hash both sides before comparing.
 *
 * timingSafeEqual THROWS a RangeError when the two buffers differ in length,
 * so the naive implementation needs a `if (a.length !== b.length) return false`
 * branch - a branch that both leaks the expected token's length through
 * timing and is the code path everyone forgets to test. Digesting to a fixed
 * 32 bytes removes the branch entirely: no length oracle, and no input can
 * make this throw.
 */
function constantTimeEquals(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export const adminAuth: MiddlewareHandler = async (c, next) => {
  const header = (c.req.header('authorization') ?? '').trim();
  const match = /^Bearer[ \t]+(.+)$/i.exec(header);
  const provided = match?.[1]?.trim() ?? '';

  // config.adminToken is guaranteed non-empty: config.ts exits the process
  // if it is unset, so there is no "unset means allow everything" branch.
  if (provided === '' || !constantTimeEquals(provided, config.adminToken)) {
    c.header('WWW-Authenticate', 'Bearer realm="sub-hub", error="invalid_token"');
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid admin token' } }, 401);
  }

  await next();
};
