import type { Configuration, PopupRequest } from '@azure/msal-browser'

const currentHost = typeof window !== 'undefined' ? window.location.hostname.toLowerCase() : ''
const useKnownProdFallback = /^(app\.phwcoloradoalpine\.org|phwalpineeventsfe873a\.azurewebsites\.net)$/i.test(currentHost)

// External ID sign-in must use the frontend SPA app registration client ID.
const fallbackClientId = useKnownProdFallback ? 'b5efba73-84dc-4bd3-a7ac-edd6fcbf910b' : undefined
const fallbackExternalTenantId = useKnownProdFallback ? 'd65d23ea-9a90-4080-b5ab-f427665cbfcf' : undefined
const fallbackExternalTenantName = useKnownProdFallback ? 'phwalpine' : undefined
const fallbackApiScope = useKnownProdFallback
  ? 'api://9a119fdd-b460-4b48-af69-a037234b8da3/access_as_user'
  : undefined
// Use a dedicated popup callback page that runs MSAL so MSAL can relay the auth response
// to the opener via BroadcastChannel (required by MSAL browser v5). Fallback to origin
// when env var is explicitly unset (non-prod dev builds without the redirect URI registered).
const fallbackPopupRedirectUri = useKnownProdFallback && typeof window !== 'undefined'
  ? `${window.location.origin}/auth/popup-callback.html`
  : undefined

const clientId = (import.meta.env.VITE_EXTERNAL_CLIENT_ID as string | undefined)
  ?? (import.meta.env.VITE_AZURE_CLIENT_ID as string | undefined)
  ?? fallbackClientId
const externalTenantId = (import.meta.env.VITE_EXTERNAL_TENANT_ID as string | undefined) ?? fallbackExternalTenantId
const externalTenantName = (import.meta.env.VITE_EXTERNAL_TENANT_NAME as string | undefined) ?? fallbackExternalTenantName
const b2cTenantName = import.meta.env.VITE_AZURE_AD_B2C_TENANT_NAME as string | undefined
const b2cPolicyName = import.meta.env.VITE_AZURE_AD_B2C_POLICY_NAME as string | undefined
const legacyTenantId = import.meta.env.VITE_AZURE_TENANT_ID as string | undefined
const authorityOverride = import.meta.env.VITE_AZURE_AUTHORITY as string | undefined
const knownAuthorityOverride = import.meta.env.VITE_AZURE_KNOWN_AUTHORITY as string | undefined
const apiScope = (import.meta.env.VITE_API_SCOPE as string | undefined) ?? fallbackApiScope
const popupRedirectUri = (import.meta.env.VITE_POPUP_REDIRECT_URI as string | undefined) ?? fallbackPopupRedirectUri
const preferPopupOnSafari = ((import.meta.env.VITE_PREFER_POPUP_ON_SAFARI as string | undefined) ?? (popupRedirectUri ? 'true' : 'false')).toLowerCase() === 'true'

const hasExternalIdConfig = Boolean(externalTenantName && externalTenantId)
const hasB2CConfig = Boolean(b2cTenantName && b2cPolicyName)
const hasAuthConfig = Boolean(clientId && (authorityOverride || hasB2CConfig || hasExternalIdConfig))

if (import.meta.env.PROD && !hasAuthConfig) {
  // Keep public routes (for example RSVP links from email) usable even if auth env vars are missing.
  console.warn('Azure AD frontend configuration is incomplete (B2C/External ID). Authenticated routes may not function.')
}

const fallbackAuthority = 'https://login.microsoftonline.com/common'
const authority = authorityOverride
  ?? (hasExternalIdConfig
    ? `https://${externalTenantName}.ciamlogin.com/${externalTenantId}`
    : hasB2CConfig
      ? `https://${b2cTenantName}.b2clogin.com/${b2cTenantName}.onmicrosoft.com/${b2cPolicyName}`
      : externalTenantName && legacyTenantId
        ? `https://${externalTenantName}.ciamlogin.com/${legacyTenantId}`
        : fallbackAuthority)

const authorityHost = (() => {
  try {
    return new URL(authority).hostname
  } catch {
    return undefined
  }
})()

const knownAuthorities = knownAuthorityOverride
  ? [knownAuthorityOverride]
  : (authorityHost ? [authorityHost] : undefined)

const msalConfig: Configuration = {
  auth: {
    // Keep MSAL initialization valid, but gate sign-in when real auth config is missing.
    clientId: clientId ?? '11111111-1111-1111-1111-111111111111',
    authority,
    knownAuthorities,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
    navigateToLoginRequestUrl: false,
  },
  cache: {
    cacheLocation: 'localStorage',
    storeAuthStateInCookie: true,
  },
}

const loginRequest: PopupRequest = {
  scopes: apiScope
    ? ['openid', 'profile', 'email', apiScope]
    : ['openid', 'profile', 'email'],
}

const ROLES = {
  ADMIN: 'ADMIN',
  EVENT_CREATOR: 'EVENT_CREATOR',
  USER: 'USER',
} as const

type AppRole = (typeof ROLES)[keyof typeof ROLES]

export { loginRequest, msalConfig, ROLES }
export { hasAuthConfig, popupRedirectUri, preferPopupOnSafari }
export type { AppRole }