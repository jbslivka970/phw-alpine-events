type TokenGetter = () => Promise<string | null>;

const DEFAULT_BASE = '/api/v1';
const rawBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? DEFAULT_BASE;
const BASE_URL = rawBase.endsWith('/') ? rawBase.slice(0, -1) : rawBase;

let getToken: TokenGetter = async () => null;

function setTokenGetter(fn: TokenGetter): void {
  getToken = fn;
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
    const message = await response.text().catch(() => response.statusText);
    throw new Error(`API ${response.status}: ${message}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: await buildHeaders(),
  });
  return parseResponse<T>(response);
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: await buildHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return parseResponse<T>(response);
}

async function apiPostForm<T>(path: string, formData: FormData): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = {};

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: formData,
  });

  return parseResponse<T>(response);
}

async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: await buildHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return parseResponse<T>(response);
}

async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'PATCH',
    headers: await buildHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return parseResponse<T>(response);
}

async function apiDelete<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'DELETE',
    headers: await buildHeaders(),
  });
  return parseResponse<T>(response);
}

async function apiGetBlob(path: string): Promise<{ blob: Blob; headers: Headers }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: await buildHeaders(),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(`API ${response.status}: ${message}`);
  }

  return { blob: await response.blob(), headers: response.headers };
}

export { BASE_URL, setTokenGetter, apiDelete, apiGet, apiGetBlob, apiPatch, apiPost, apiPostForm, apiPut };