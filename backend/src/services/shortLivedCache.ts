import { createClient } from 'redis';

type CacheEntry = {
  value: unknown;
  expiresAtMs: number;
};

type CacheProvider = 'memory' | 'redis';

type ShortLivedCacheStatus = {
  provider: CacheProvider;
  redisConfigured: boolean;
  redisConnected: boolean;
  redisUrlDefined: boolean;
  redisKeyPrefix: string;
  required: boolean;
  lastRedisError: string | null;
};

type ShortLivedCacheProbeResult = {
  ok: boolean;
  provider: CacheProvider;
  redisConfigured: boolean;
  redisConnected: boolean;
  durationMs: number;
  error?: string;
};

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();

const redisUrl = (process.env['REDIS_URL'] ?? '').trim();
const redisKeyPrefix = (process.env['REDIS_KEY_PREFIX'] ?? 'phw:cache:').trim() || 'phw:cache:';
const cacheProviderMode = (process.env['CACHE_PROVIDER'] ?? 'auto').trim().toLowerCase();
const redisRequired = ['1', 'true', 'yes', 'on'].includes((process.env['CACHE_REDIS_REQUIRED'] ?? '').trim().toLowerCase());
const redisConnectTimeoutMs = Math.max(Number.parseInt(process.env['REDIS_CONNECT_TIMEOUT_MS'] ?? '3000', 10) || 3000, 500);
const redisProbeTimeoutMs = Math.max(Number.parseInt(process.env['REDIS_PROBE_TIMEOUT_MS'] ?? '3000', 10) || 3000, 500);

const provider: CacheProvider = cacheProviderMode === 'redis'
  ? 'redis'
  : cacheProviderMode === 'memory'
    ? 'memory'
    : redisUrl
      ? 'redis'
      : 'memory';

type AnyRedisClient = ReturnType<typeof createClient>;

let redisClient: AnyRedisClient | null = null;
let redisConnected = false;
let redisConnectPromise: Promise<AnyRedisClient | null> | null = null;
let redisReconnectAllowedAt = 0;
let lastRedisError: string | null = null;

function namespacedKey(key: string): string {
  return `${redisKeyPrefix}${key}`;
}

function recordRedisError(error: unknown, context: string): void {
  const message = error instanceof Error ? error.message : String(error);
  lastRedisError = `${context}: ${message}`;
  console.warn(`[cache] Redis ${context}: ${message}`);
}

function connectWithTimeout(client: AnyRedisClient): Promise<void> {
  return Promise.race([
    client.connect().then(() => undefined),
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error(`connect timeout after ${redisConnectTimeoutMs}ms`)), redisConnectTimeoutMs);
    }),
  ]);
}

function withProbeTimeout<T>(operation: Promise<T>): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`probe timeout after ${redisProbeTimeoutMs}ms`)), redisProbeTimeoutMs);
    }),
  ]);
}

async function getRedisClient(): Promise<AnyRedisClient | null> {
  if (provider !== 'redis' || !redisUrl) {
    return null;
  }

  if (redisClient?.isOpen) {
    redisConnected = true;
    return redisClient;
  }

  if (redisConnectPromise) {
    return redisConnectPromise;
  }

  const now = Date.now();
  if (now < redisReconnectAllowedAt) {
    return null;
  }

  redisConnectPromise = (async () => {
    const client = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: redisConnectTimeoutMs,
      },
    });

    client.on('error', (error) => {
      redisConnected = false;
      recordRedisError(error, 'runtime error');
    });

    try {
      await connectWithTimeout(client);
      redisClient = client;
      redisConnected = true;
      lastRedisError = null;
      console.log('[cache] Redis connected; short-lived cache is using distributed mode');
      return client;
    } catch (error) {
      redisConnected = false;
      redisReconnectAllowedAt = Date.now() + 30_000;
      try {
        if (client.isOpen) {
          await client.quit();
        }
      } catch {
        // Ignore close errors.
      }
      recordRedisError(error, 'connect failed');
      return null;
    } finally {
      redisConnectPromise = null;
    }
  })();

  return redisConnectPromise;
}

async function getFromRedis<T>(key: string): Promise<T | null> {
  const client = await getRedisClient();
  if (!client) {
    return null;
  }

  try {
    const payload = await client.get(namespacedKey(key));
    if (!payload) {
      return null;
    }

    return JSON.parse(payload) as T;
  } catch (error) {
    recordRedisError(error, `read failed for key ${key}`);
    return null;
  }
}

async function setInRedis(key: string, ttlMs: number, value: unknown): Promise<void> {
  const client = await getRedisClient();
  if (!client) {
    return;
  }

  try {
    await client.set(namespacedKey(key), JSON.stringify(value), {
      PX: ttlMs,
    });
  } catch (error) {
    recordRedisError(error, `write failed for key ${key}`);
  }
}

async function invalidateRedisByPrefix(prefix?: string): Promise<void> {
  const client = await getRedisClient();
  if (!client) {
    return;
  }

  const scanPattern = prefix
    ? `${redisKeyPrefix}${prefix}*`
    : `${redisKeyPrefix}*`;

  try {
    for await (const key of client.scanIterator({ MATCH: scanPattern, COUNT: 200 })) {
      await client.del(String(key));
    }
  } catch (error) {
    recordRedisError(error, `invalidate failed for pattern ${scanPattern}`);
  }
}

export async function initializeShortLivedCache(): Promise<void> {
  if (provider !== 'redis') {
    return;
  }

  if (!redisUrl) {
    const message = 'CACHE_PROVIDER=redis but REDIS_URL is empty';
    lastRedisError = message;
    if (redisRequired) {
      throw new Error(message);
    }
    console.warn(`[cache] ${message}; falling back to in-memory cache`);
    return;
  }

  const client = await getRedisClient();
  if (!client && redisRequired) {
    throw new Error(lastRedisError ?? 'Redis connection failed while CACHE_REDIS_REQUIRED=true');
  }
}

export async function withShortLivedCache<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAtMs > now) {
    return existing.value as T;
  }

  if (provider === 'redis') {
    const redisValue = await getFromRedis<T>(key);
    if (redisValue !== null) {
      const normalizedTtlMs = Math.max(Math.floor(ttlMs), 500);
      cache.set(key, {
        value: redisValue,
        expiresAtMs: Date.now() + normalizedTtlMs,
      });
      return redisValue;
    }
  }

  const pending = inFlight.get(key);
  if (pending) {
    return pending as Promise<T>;
  }

  const normalizedTtlMs = Math.max(Math.floor(ttlMs), 500);
  const loadPromise = (async () => {
    const value = await loader();
    cache.set(key, {
      value,
      expiresAtMs: Date.now() + normalizedTtlMs,
    });
    if (provider === 'redis') {
      await setInRedis(key, normalizedTtlMs, value);
    }
    return value;
  })();

  inFlight.set(key, loadPromise);

  try {
    return await loadPromise;
  } finally {
    inFlight.delete(key);
  }
}

export function invalidateShortLivedCache(prefix?: string): number {
  if (!prefix) {
    const size = cache.size;
    cache.clear();
    if (provider === 'redis') {
      void invalidateRedisByPrefix();
    }
    return size;
  }

  let removed = 0;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      removed += 1;
    }
  }

  if (provider === 'redis') {
    void invalidateRedisByPrefix(prefix);
  }

  return removed;
}

export function pruneExpiredShortLivedCache(nowMs = Date.now()): number {
  let removed = 0;
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      cache.delete(key);
      removed += 1;
    }
  }
  return removed;
}

export function getShortLivedCacheRuntimeStatus(): ShortLivedCacheStatus {
  return {
    provider,
    redisConfigured: provider === 'redis',
    redisConnected,
    redisUrlDefined: redisUrl.length > 0,
    redisKeyPrefix,
    required: redisRequired,
    lastRedisError,
  };
}

export async function runShortLivedCacheProbe(): Promise<ShortLivedCacheProbeResult> {
  const startedAt = Date.now();
  const baseStatus = getShortLivedCacheRuntimeStatus();

  if (baseStatus.provider !== 'redis') {
    return {
      ok: true,
      provider: baseStatus.provider,
      redisConfigured: baseStatus.redisConfigured,
      redisConnected: baseStatus.redisConnected,
      durationMs: Date.now() - startedAt,
    };
  }

  const client = await getRedisClient();
  if (!client) {
    return {
      ok: false,
      provider: baseStatus.provider,
      redisConfigured: baseStatus.redisConfigured,
      redisConnected: false,
      durationMs: Date.now() - startedAt,
      error: lastRedisError ?? 'Redis client is not connected.',
    };
  }

  const probeKey = namespacedKey(`probe:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`);
  const probeValue = 'ok';

  try {
    await withProbeTimeout(client.set(probeKey, probeValue, { PX: 10_000 }));
    const readBack = await withProbeTimeout(client.get(probeKey));
    await withProbeTimeout(client.del(probeKey));

    if (readBack !== probeValue) {
      return {
        ok: false,
        provider: baseStatus.provider,
        redisConfigured: baseStatus.redisConfigured,
        redisConnected: true,
        durationMs: Date.now() - startedAt,
        error: 'Probe round-trip value mismatch.',
      };
    }

    return {
      ok: true,
      provider: baseStatus.provider,
      redisConfigured: baseStatus.redisConfigured,
      redisConnected: true,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    recordRedisError(error, 'probe failed');
    return {
      ok: false,
      provider: baseStatus.provider,
      redisConfigured: baseStatus.redisConfigured,
      redisConnected,
      durationMs: Date.now() - startedAt,
      error: lastRedisError ?? 'Redis probe failed.',
    };
  }
}
