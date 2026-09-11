const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT) || 8080;

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const staticPageRoutes = new Map([
  ['/privacy', '/privacy.html'],
  ['/terms', '/terms.html'],
  ['/consent', '/consent.html'],
  ['/sms-program', '/sms-program.html'],
  ['/sms-messaging', '/sms-messaging.html'],
]);

function resolveRequestPath(requestUrl) {
  const url = new URL(requestUrl || '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const staticPage = staticPageRoutes.get(pathname.replace(/\/$/, ''));
  if (staticPage) {
    return staticPage;
  }
  return pathname;
}

function safeFilePath(requestPath) {
  const normalized = path.normalize(requestPath).replace(/^([/\\])+/, '');
  const candidate = path.join(root, normalized || 'index.html');
  return candidate.startsWith(root) ? candidate : path.join(root, 'index.html');
}

function sendFile(response, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = contentTypes.get(extension) || 'application/octet-stream';
  const isAsset = filePath.includes(`${path.sep}assets${path.sep}`);
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache, no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Strict-Transport-Security': 'max-age=31536000',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob: https:; connect-src 'self' https://phwalpineeventsjb873a.azurewebsites.net https://phwalpineeventsjb873a-staging.azurewebsites.net https://login.microsoftonline.com https://login.microsoft.com https://sts.windows.net https://phwalpine.ciamlogin.com https://*.ciamlogin.com https://*.b2clogin.com; frame-ancestors 'self'; form-action 'self'; object-src 'none'; base-uri 'self'",
  };

  if (!isAsset) {
    headers.Pragma = 'no-cache';
    headers.Expires = '0';
  }

  response.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(response);
}

function serve(request, response) {
  const requestPath = resolveRequestPath(request.url);
  const candidate = safeFilePath(requestPath);

  fs.stat(candidate, (error, stats) => {
    if (!error && stats.isFile()) {
      sendFile(response, candidate);
      return;
    }

    if (path.extname(candidate)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    sendFile(response, path.join(root, 'index.html'));
  });
}

http.createServer(serve).listen(port, () => {
  console.log(`Frontend server listening on ${port}`);
});