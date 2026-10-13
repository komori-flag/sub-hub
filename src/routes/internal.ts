import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from '../config.js';
import { getTemplate } from '../db.js';

/**
 * Serves locally stored templates to Subconverter, on loopback only.
 *
 * Why a port at all: Subconverter takes its template as a `config=` URL, so a
 * template held in this database still has to be reachable over HTTP for it to
 * be used at all.
 *
 * Why local templates exist: a template that has to live in a public git repo
 * cannot hold internal hostnames or tunnel endpoints. Keeping the document
 * here means it never leaves the machine.
 *
 * Security posture:
 *
 *  - The bind address is hardcoded to 127.0.0.1 and is NOT configurable. There
 *    is no authentication because Subconverter cannot send any, so loopback IS
 *    the access control. A settable host would be one env var away from
 *    publishing template contents - which, unlike the published-template case,
 *    are expected to be private.
 *  - Requests are by opaque id, never by name, so a guessed URL is not a way
 *    to enumerate what is stored.
 */
export function internalTemplateUrl(templateId: string): string {
  return `http://127.0.0.1:${config.internalPort}/template/${encodeURIComponent(templateId)}`;
}

export function internalServerEnabled(): boolean {
  return config.internalPort > 0;
}

const internal = new Hono();

internal.get('/template/:id', async (c) => {
  const template = await getTemplate(c.req.param('id'));
  if (!template) return c.text('# no such template', 404);
  return c.text(template.content);
});

/** Starts the loopback server, or returns null when INTERNAL_PORT is 0. */
export function startInternalServer(): (() => void) | null {
  if (!internalServerEnabled()) return null;

  const server = serve(
    { fetch: internal.fetch, port: config.internalPort, hostname: '127.0.0.1' },
    () => {
      console.log(
        `[boot] local templates on http://127.0.0.1:${config.internalPort} (loopback only)`,
      );
    },
  );

  return () => server.close();
}
