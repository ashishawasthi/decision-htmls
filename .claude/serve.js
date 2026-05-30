// Minimal static file server for the decision-tools site.
// Serves the repository root (the parent of this .claude folder) so every
// HTML file is reachable. Independent of the working directory: paths are
// resolved from __dirname, and the port can be passed as the first argument
// (defaults to 8765).
//
//   node .claude/serve.js [port]

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8765);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  // Keep every request inside ROOT so a crafted path cannot escape the folder.
  const fp = path.join(ROOT, path.normalize(rel));
  if (fp !== ROOT && !fp.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 forbidden');
    return;
  }

  fs.readFile(fp, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 not found: ' + rel);
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('serving ' + ROOT + ' on http://localhost:' + PORT + '/');
});
