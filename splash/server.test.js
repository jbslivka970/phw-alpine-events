const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('./server');

function startServer() {
  const server = createServer({ rootDir: __dirname });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('serves the splash home page and a static asset', async () => {
  const server = await startServer();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const homeResponse = await fetch(`${baseUrl}/`);
    assert.equal(homeResponse.status, 200);
    const homeBody = await homeResponse.text();
    assert.match(homeBody, /PHW Colorado Alpine Chapter/);

    const assetResponse = await fetch(`${baseUrl}/staticwebapp.config.json`);
    assert.equal(assetResponse.status, 200);
    const assetBody = await assetResponse.text();
    assert.match(assetBody, /navigationFallback/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
