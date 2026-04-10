type TokenGetter = () => Promise<string | null>;

const DEFAULT_BASE = '/api/v1';
const rawBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? DEFAULT_BASE;
const resolvedBase = rawBase;
const BASE_URL = resolvedBase.endsWith('/') ? resolvedBase.slice(0, -1) : resolvedBase;

let getToken: TokenGetter = async () => null;
const AUTH_RETRY_DELAY_MS = 250;
const TOKEN_CACHE_TTL_MS = 30_000;
let cachedToken: string | null | undefined;
let cachedTokenAtMs = 0;
let tokenRequestInFlight: Promise<string | null> | null = null;

function clearTokenCache(): void {
  cachedToken = undefined;
  cachedTokenAtMs = 0;
  tokenRequestInFlight = null;
}

function setTokenGetter(fn: TokenGetter): void {
  getToken = fn;
  clearTokenCache();
}

async function getCachedToken(): Promise<string | null> {
  const now = Date.now();
  if (cachedToken !== undefined && (now - cachedTokenAtMs) < TOKEN_CACHE_TTL_MS) {
    return cachedToken;
  }

  if (tokenRequestInFlight) {
    return tokenRequestInFlight;
  }

  tokenRequestInFlight = (async () => {
    const token = await getToken();
    cachedToken = token;
    cachedTokenAtMs = Date.now();
    return token;
  })();

  try {
    return await tokenRequestInFlight;
  } finally {
    tokenRequestInFlight = null;
  }
}

function hasAuthorizationHeader(headers?: HeadersInit): boolean {
  if (!headers) {
    return false;
  }
  const normalized = new Headers(headers);
  return normalized.has('Authorization');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWithAuthRetry(
  path: string,
  initFactory: () => Promise<RequestInit>
): Promise<Response> {
  const url = `${BASE_URL}${path}`;
  const initialInit = await initFactory();
  let response = await fetch(url, initialInit);

  if (response.status !== 401) {
    return response;
  }

  // Force a fresh token read before retrying after auth failures.
  clearTokenCache();

  const initialHadAuth = hasAuthorizationHeader(initialInit.headers);
  if (!initialHadAuth) {
    await delay(AUTH_RETRY_DELAY_MS);
  }

  const retryInit = await initFactory();
  const retryHasAuth = hasAuthorizationHeader(retryInit.headers);

  // Retry when a token was not yet available (or becomes available) during auth warm-up.
  if (!initialHadAuth || retryHasAuth) {
    response = await fetch(url, retryInit);
  }

  return response;
}

async function buildHeaders(extra?: HeadersInit): Promise<HeadersInit> {
  const token = await getCachedToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(extra as Record<string, string> | undefined),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = response.statusText;
    try {
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const payload = (await response.json()) as { error?: unknown; message?: unknown };
        if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
          message = payload.error;
        } else if (typeof payload.message === 'string' && payload.message.trim().length > 0) {
          message = payload.message;
        }
      } else {
        const text = await response.text();
        if (text.trim().length > 0) {
          message = text;
        }
      }
    } catch {
      // Fall back to status text when parsing fails.
    }

    throw new Error(`API ${response.status}: ${message}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetchWithAuthRetry(path, async () => ({
    method: 'GET',
    headers: await buildHeaders(),
  }));
  return parseResponse<T>(response);
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetchWithAuthRetry(path, async () => ({
    method: 'POST',
    headers: await buildHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
  return parseResponse<T>(response);
}

async function apiPostForm<T>(path: string, formData: FormData): Promise<T> {
  const response = await fetchWithAuthRetry(path, async () => {
    const token = await getCachedToken();
    const headers: Record<string, string> = {};

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return {
      method: 'POST',
      headers,
      body: formData,
    };
  });

  return parseResponse<T>(response);
}

async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetchWithAuthRetry(path, async () => ({
    method: 'PUT',
    headers: await buildHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
  return parseResponse<T>(response);
}

async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetchWithAuthRetry(path, async () => ({
    method: 'PATCH',
    headers: await buildHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
  return parseResponse<T>(response);
}

async function apiDelete<T>(path: string): Promise<T> {
  const response = await fetchWithAuthRetry(path, async () => ({
    method: 'DELETE',
    headers: await buildHeaders(),
  }));
  return parseResponse<T>(response);
}

async function apiGetBlob(path: string): Promise<{ blob: Blob; headers: Headers }> {
  const response = await fetchWithAuthRetry(path, async () => ({
    method: 'GET',
    headers: await buildHeaders(),
  }));

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(`API ${response.status}: ${message}`);
  }

  return { blob: await response.blob(), headers: response.headers };
}

export { BASE_URL, setTokenGetter, apiDelete, apiGet, apiGetBlob, apiPatch, apiPost, apiPostForm, apiPut };