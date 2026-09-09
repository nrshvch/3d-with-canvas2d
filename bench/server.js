'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), url = require('url');
const ROOT = __dirname, OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT || 8123);
const leases = new Map();   // tag -> last heartbeat ms
const LEASE_TTL = 20000;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
               '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  if (req.method === 'POST' && u.pathname === '/result') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const tag = (u.query.tag || 'unknown').replace(/[^a-z0-9_.-]/gi, '');
      fs.writeFileSync(path.join(OUT, tag + '.json'), body);
      console.log('[server] wrote out/' + tag + '.json (' + body.length + ' bytes)');
      res.writeHead(200, { 'access-control-allow-origin': '*' }); res.end('ok');
    });
    return;
  }
  if (u.pathname === '/ping') { res.writeHead(200); res.end('pong'); return; }
  // single-instance lease: browsers sometimes open the start URL twice, and two
  // concurrent benchmark pages destroy every number on the page.
  if (u.pathname === '/lease' || u.pathname === '/beat') {
    const tag = String(u.query.tag || ''), now = Date.now();
    const prev = leases.get(tag);
    // A lease that stopped heart-beating (crashed / killed page) expires, so an
    // aborted run can never wedge the next one.
    const ok = !prev || now - prev > LEASE_TTL || u.pathname === '/beat';
    if (ok) leases.set(tag, now);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ granted: ok }));
    return;
  }
  if (u.pathname === '/release') { leases.delete(String(u.query.tag || '')); res.writeHead(200); res.end('ok'); return; }
  let p = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\/+/, ''));
  if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(d);
  });
}).listen(PORT, () => console.log('[server] http://localhost:' + PORT + '/'));
