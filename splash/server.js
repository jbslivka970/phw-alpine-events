const http = require('http');
const path = require('path');
const fs = require('fs');

function createServer({ rootDir = process.cwd(), port = Number(process.env.PORT || 8080) } = {}) {
  const resolvedRoot = path.resolve(rootDir);
  return http.createServer((req, res) => {
    const requestPath = req.url === '/' ? '/index.html' : req.url;
    const safePath = path.normalize(requestPath).replace(/^\/+/, '');
    const filePath = path.join(resolvedRoot, safePath);

    if (!filePath.startsWith(resolvedRoot)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
          ? 'application/javascript; charset=utf-8'
          : ext === '.json'
            ? 'application/json; charset=utf-8'
            : 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(fs.readFileSync(filePath));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(process.env.PORT || 8080, () => {
    console.log(`Splash server listening on ${process.env.PORT || 8080}`);
  });
}

module.exports = { createServer };
