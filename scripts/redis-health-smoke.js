#!/usr/bin/env node

const baseUrl = (process.env.BACKEND_BASE_URL || '').trim();

if (!baseUrl) {
  console.error('BACKEND_BASE_URL is required');
  process.exit(1);
}

const endpoint = `${baseUrl.replace(/\/$/, '')}/api/v1/health/redis`;
const expectedProvider = (process.env.REDIS_SMOKE_EXPECT_PROVIDER || '').trim().toLowerCase();
const requireConfigured = ['1', 'true', 'yes', 'on'].includes((process.env.REDIS_SMOKE_REQUIRE_CONFIGURED || '').trim().toLowerCase());
const requireConnected = ['1', 'true', 'yes', 'on'].includes((process.env.REDIS_SMOKE_REQUIRE_CONNECTED || '').trim().toLowerCase());
const requestTimeoutMs = Math.max(Number.parseInt(process.env.REDIS_SMOKE_TIMEOUT_MS || '20000', 10) || 20000, 1000);
const retryAttempts = Math.max(Number.parseInt(process.env.REDIS_SMOKE_RETRIES || '12', 10) || 12, 1);
const retryDelayMs = Math.max(Number.parseInt(process.env.REDIS_SMOKE_RETRY_DELAY_MS || '5000', 10) || 5000, 250);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evaluateResult(response, payload) {
  const provider = payload?.cache?.provider ?? 'unknown';
  const cacheConnected = payload?.cache?.redisConnected;
  const probeConnected = payload?.probe?.redisConnected;
  const connected = typeof probeConnected === 'boolean'
    ? probeConnected
    : (typeof cacheConnected === 'boolean' ? cacheConnected : false);
  const configured = payload?.cache?.redisConfigured ?? false;
  const required = payload?.cache?.required ?? false;
  const probeOk = payload?.probe?.ok ?? false;

  if (!response.ok) {
    return {
      ok: false,
      reason: `Redis health endpoint returned HTTP ${response.status}`,
      provider,
      configured,
      connected,
      cacheConnected,
      probeConnected,
      required,
      probeOk,
    };
  }

  if (expectedProvider && provider !== expectedProvider) {
    return {
      ok: false,
      reason: `Expected cache provider '${expectedProvider}' but found '${provider}'.`,
      provider,
      configured,
      connected,
      cacheConnected,
      probeConnected,
      required,
      probeOk,
    };
  }

  if (requireConfigured && !configured) {
    return {
      ok: false,
      reason: 'Redis health smoke requires redisConfigured=true.',
      provider,
      configured,
      connected,
      cacheConnected,
      probeConnected,
      required,
      probeOk,
    };
  }

  if (requireConnected && !connected) {
    return {
      ok: false,
      reason: 'Redis health smoke requires redisConnected=true.',
      provider,
      configured,
      connected,
      cacheConnected,
      probeConnected,
      required,
      probeOk,
    };
  }

  if (provider === 'redis' && !probeOk) {
    return {
      ok: false,
      reason: 'Redis provider is active but probe failed.',
      provider,
      configured,
      connected,
      cacheConnected,
      probeConnected,
      required,
      probeOk,
    };
  }

  return {
    ok: true,
    reason: 'PASS',
    provider,
    configured,
    connected,
    cacheConnected,
    probeConnected,
    required,
    probeOk,
  };
}

async function main() {
  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    const startedAt = Date.now();
    let response;
    let payload = null;
    let requestError = null;

    try {
      response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });

      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
    } catch (error) {
      requestError = error instanceof Error ? error.message : String(error);
      response = { ok: false, status: 0 };
    }

    const result = evaluateResult(response, payload);
    const durationMs = Date.now() - startedAt;

    console.log(`redis_endpoint=${endpoint}`);
    console.log(`attempt=${attempt}/${retryAttempts}`);
    console.log(`http_status=${response.status || 'request_error'}`);
    if (requestError) {
      console.log(`request_error=${requestError}`);
    }
    console.log(`provider=${result.provider}`);
    console.log(`redis_configured=${result.configured}`);
    console.log(`redis_connected=${result.connected}`);
    console.log(`cache_redis_connected=${result.cacheConnected ?? 'unknown'}`);
    console.log(`probe_redis_connected=${result.probeConnected ?? 'unknown'}`);
    console.log(`redis_required=${result.required}`);
    console.log(`probe_ok=${result.probeOk}`);
    console.log(`duration_ms=${durationMs}`);

    if (result.ok) {
      console.log('result=PASS');
      return;
    }

    if (attempt < retryAttempts) {
      console.warn(`${result.reason} Retrying in ${retryDelayMs}ms...`);
      await sleep(retryDelayMs);
      continue;
    }

    console.error(result.reason);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
