type TokenGetter = () => Promise<string | null>;

const DEFAULT_BASE = '/api/v1';
const rawBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? DEFAULT_BASE;
const PRODUCTION_BACKEND_FALLBACK = 'https://phwalpineeventsjb873a.azurewebsites.net/api/v1';
const shouldUseProductionFallback = import.meta.env.PROD
  && rawBase === DEFAULT_BASE
  && typeof window !== 'undefined'
  && /^(phwalpineeventsfe873a\.azurewebsites\.net|app\.phwcoloradoalpine\.org)$/i.test(window.location.hostname);
const resolvedBase = shouldUseProductionFallback ? PRODUCTION_BACKEND_FALLBACK : rawBase;
const BASE_URL = resolvedBase.endsWith('/') ? resolvedBase.slice(0, -1) : resolvedBase;

let getToken: TokenGetter = async () => null;
const AUTH_RETRY_DELAY_MS = 250;

function setTokenGetter(fn: TokenGetter): void {
  getToken = fn;
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
  const token = await getToken();
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
    const token = await getToken();
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