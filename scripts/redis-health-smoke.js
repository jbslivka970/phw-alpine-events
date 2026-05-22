#!/usr/bin/env node

const baseUrl = (process.env.BACKEND_BASE_URL || '').trim();

if (!baseUrl) {
  console.error('BACKEND_BASE_URL is required');
  process.exit(1);
}

const endpoint = `${baseUrl.replace(/\/$/, '')}/api/v1/health/redis`;

async function main() {
  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const provider = payload?.cache?.provider ?? 'unknown';
  const connected = payload?.cache?.redisConnected ?? false;
  const configured = payload?.cache?.redisConfigured ?? false;
  const required = payload?.cache?.required ?? false;
  const probeOk = payload?.probe?.ok ?? false;

  console.log(`redis_endpoint=${endpoint}`);
  console.log(`http_status=${response.status}`);
  console.log(`provider=${provider}`);
  console.log(`redis_configured=${configured}`);
  console.log(`redis_connected=${connected}`);
  console.log(`redis_required=${required}`);
  console.log(`probe_ok=${probeOk}`);
  console.log(`duration_ms=${Date.now() - startedAt}`);

  if (!response.ok) {
    console.error(`Redis health endpoint returned HTTP ${response.status}`);
    process.exit(1);
  }

  if (provider === 'redis' && !probeOk) {
    console.error('Redis provider is active but probe failed.');
    process.exit(1);
  }

  console.log('result=PASS');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
