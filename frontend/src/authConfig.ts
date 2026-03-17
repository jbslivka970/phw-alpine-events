import type { Configuration, PopupRequest } from '@azure/msal-browser'

const clientId = (import.meta.env.VITE_EXTERNAL_CLIENT_ID as string | undefined)
  ?? (import.meta.env.VITE_AZURE_CLIENT_ID as string | undefined)
const tenantId = (import.meta.env.VITE_EXTERNAL_TENANT_ID as string | undefined)
  ?? (import.meta.env.VITE_AZURE_TENANT_ID as string | undefined)
const tenantName = (import.meta.env.VITE_EXTERNAL_TENANT_NAME as string | undefined)
  ?? (import.meta.env.VITE_AZURE_AD_B2C_TENANT_NAME as string | undefined)
const policyName = (import.meta.env.VITE_EXTERNAL_USER_FLOW as string | undefined)
  ?? (import.meta.env.VITE_AZURE_AD_B2C_POLICY_NAME as string | undefined)
const authorityOverride = import.meta.env.VITE_AZURE_AUTHORITY as string | undefined
const knownAuthorityOverride = import.meta.env.VITE_AZURE_KNOWN_AUTHORITY as string | undefined
const apiScope = import.meta.env.VITE_API_SCOPE as string | undefined

if (import.meta.env.PROD && (!clientId || !tenantId || !tenantName || !policyName)) {
  throw new Error('Azure AD B2C frontend configuration is incomplete.')
}

const fallbackAuthority = 'https://login.microsoftonline.com/common'
const authority = authorityOverride
  ?? (tenantName && policyName
    ? `https://${tenantName}.b2clogin.com/${tenantName}.onmicrosoft.com/${policyName}`
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
    clientId: clientId ?? 'dev-placeholder-client-id',
    authority,
    knownAuthorities,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
    navigateToLoginRequestUrl: true,
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
}

const loginRequest: PopupRequest = {
  scopes: apiScope ? [apiScope] : ['openid', 'profile', 'email'],
}

const ROLES = {
  ADMIN: 'ADMIN',
  EVENT_CREATOR: 'EVENT_CREATOR',
  USER: 'USER',
} as const

type AppRole = (typeof ROLES)[keyof typeof ROLES]

export { loginRequest, msalConfig, ROLES }
export type { AppRole }