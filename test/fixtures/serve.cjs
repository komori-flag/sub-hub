/*
 * Serves test/fixtures over HTTP so a locally-running Subconverter can fetch
 * them as if they were real subscriptions. Used by the end-to-end check in
 * the README; not part of the service.
 *
 *   node test/fixtures/serve.cjs [port]     # default 8801
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.argv[2] || 8801);
const dir = __dirname;

http
  .createServer((req, res) => {
    const name = path.basename((req.url || '/').split('?')[0]);
    const file = path.join(dir, name);
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(fs.readFileSync(file));
  })
  .listen(port, '127.0.0.1', () => {
    console.log('fixtures on http://127.0.0.1:' + port + '/sub1.yml and /sub2.yml');
  });
