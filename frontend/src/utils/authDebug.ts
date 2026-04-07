const AUTH_DEBUG_QUERY_KEY = 'authDebug'
const AUTH_DEBUG_STORAGE_KEY = 'phw:auth-debug'

const envDebugEnabled = ((import.meta.env.VITE_AUTH_DEBUG as string | undefined) ?? '').toLowerCase() === 'true'

function readQueryDebugFlag(): boolean | null {
  if (typeof window === 'undefined') {
    return null
  }

  const params = new URLSearchParams(window.location.search)
  if (!params.has(AUTH_DEBUG_QUERY_KEY)) {
    return null
  }

  const value = (params.get(AUTH_DEBUG_QUERY_KEY) ?? '').toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

function readStoredDebugFlag(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  return window.localStorage.getItem(AUTH_DEBUG_STORAGE_KEY) === '1'
}

function writeStoredDebugFlag(enabled: boolean): void {
  if (typeof window === 'undefined') {
    return
  }
  if (enabled) {
    window.localStorage.setItem(AUTH_DEBUG_STORAGE_KEY, '1')
  } else {
    window.localStorage.removeItem(AUTH_DEBUG_STORAGE_KEY)
  }
}

function resolveAuthDebugEnabled(): boolean {
  const queryValue = readQueryDebugFlag()
  if (queryValue != null) {
    writeStoredDebugFlag(queryValue)
    return queryValue
  }
  return envDebugEnabled || readStoredDebugFlag()
}

const authDebugEnabled = resolveAuthDebugEnabled()

function redact(value: unknown): unknown {
  if (value == null) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(redact)
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return Object.fromEntries(entries.map(([key, nestedValue]) => {
      const lowerKey = key.toLowerCase()
      if (lowerKey.includes('token') || lowerKey.includes('secret') || lowerKey.includes('password')) {
        return [key, '[redacted]']
      }
      return [key, redact(nestedValue)]
    }))
  }

  if (typeof value === 'string' && value.length > 220) {
    return `${value.slice(0, 220)}...[truncated]`
  }

  return value
}

function authDebugLog(stage: string, details?: unknown): void {
  if (!authDebugEnabled) {
    return
  }

  const timestamp = new Date().toISOString()
  if (details === undefined) {
    console.info(`[AUTHDBG ${timestamp}] ${stage}`)
    return
  }

  console.info(`[AUTHDBG ${timestamp}] ${stage}`, redact(details))
}

function authDebugWarn(stage: string, details?: unknown): void {
  if (!authDebugEnabled) {
    return
  }

  const timestamp = new Date().toISOString()
  if (details === undefined) {
    console.warn(`[AUTHDBG ${timestamp}] ${stage}`)
    return
  }

  console.warn(`[AUTHDBG ${timestamp}] ${stage}`, redact(details))
}

function authDebugError(stage: string, details?: unknown): void {
  if (!authDebugEnabled) {
    return
  }

  const timestamp = new Date().toISOString()
  if (details === undefined) {
    console.error(`[AUTHDBG ${timestamp}] ${stage}`)
    return
  }

  console.error(`[AUTHDBG ${timestamp}] ${stage}`, redact(details))
}

export { authDebugEnabled, authDebugLog, authDebugWarn, authDebugError }