type CacheEntry = {
  value: unknown;
  expiresAtMs: number;
};

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();

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
    return size;
  }

  let removed = 0;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      removed += 1;
    }
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
