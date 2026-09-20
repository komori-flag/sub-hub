import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';

export const admin = new Hono();

/**
 * Resolved relative to THIS module, not process.cwd(). That matters: a
 * serveStatic({ path: './public/...' }) resolves against the working
 * directory, so it works under `npm run dev` and then silently 404s in the
 * container if WORKDIR is ever anything but /app. import.meta.dirname is
 * src/routes under tsx and dist/routes when compiled, and ../../public is
 * the project root either way.
 */
const ADMIN_HTML_PATH = join(import.meta.dirname, '..', '..', 'public', 'admin.html');

let cached: string | null = null;

function loadAdminHtml(): string {
  if (cached === null) cached = readFileSync(ADMIN_HTML_PATH, 'utf8');
  return cached;
}

/**
 * Public to fetch, empty of secrets - it is the login screen. Everything it
 * can actually DO goes through /api/*, which requires the token.
 */
admin.get('/admin', (c) => {
  let html: string;
  try {
    html = loadAdminHtml();
  } catch (err) {
    // Precise and actionable: this is a deployment error (public/ not copied
    // into the image), not a runtime one.
    console.error('[admin] cannot read', ADMIN_HTML_PATH, err);
    return c.text(`admin console not available: cannot read ${ADMIN_HTML_PATH}`, 500);
  }
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.html(html);
});
