const DEFAULT_API_BASE_URL = '/api/v1'
const PRODUCTION_BACKEND_API_BASE_URL = 'https://phwalpineeventsjb873a.azurewebsites.net/api/v1'
const PRODUCTION_FRONTEND_HOSTS = new Set([
  'app.phwcoloradoalpine.org',
  'phwalpineeventsfe873a.azurewebsites.net',
])

function normalizeApiBaseUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return DEFAULT_API_BASE_URL
  }

  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

export function getApiBaseUrl(): string {
  const configuredBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)
  if (configuredBase && configuredBase.trim().length > 0) {
    return normalizeApiBaseUrl(configuredBase)
  }

  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname.toLowerCase()
    if (PRODUCTION_FRONTEND_HOSTS.has(hostname)) {
      return PRODUCTION_BACKEND_API_BASE_URL
    }
  }

  return DEFAULT_API_BASE_URL
}