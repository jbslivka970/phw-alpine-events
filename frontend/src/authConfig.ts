import type { Configuration, PopupRequest } from '@azure/msal-browser'

const clientId = import.meta.env.VITE_AZURE_CLIENT_ID as string | undefined
const tenantId = import.meta.env.VITE_AZURE_TENANT_ID as string | undefined
const tenantName = import.meta.env.VITE_AZURE_AD_B2C_TENANT_NAME as string | undefined
const policyName = import.meta.env.VITE_AZURE_AD_B2C_POLICY_NAME as string | undefined
const authorityOverride = import.meta.env.VITE_AZURE_AUTHORITY as string | undefined

if (import.meta.env.PROD && (!clientId || !tenantId || !tenantName || !policyName)) {
  throw new Error('Azure AD B2C frontend configuration is incomplete.')
}

const fallbackAuthority = 'https://login.microsoftonline.com/common'
const authority = authorityOverride
  ?? (tenantName && policyName
    ? `https://${tenantName}.b2clogin.com/${tenantName}.onmicrosoft.com/${policyName}`
    : fallbackAuthority)

const knownAuthorities = tenantName ? [`${tenantName}.b2clogin.com`] : undefined

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
  scopes: ['openid', 'profile', 'email'],
}

const ROLES = {
  ADMIN: 'ADMIN',
  EVENT_CREATOR: 'EVENT_CREATOR',
  USER: 'USER',
} as const

type AppRole = (typeof ROLES)[keyof typeof ROLES]

export { loginRequest, msalConfig, ROLES }
export type { AppRole }