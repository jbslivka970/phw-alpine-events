import type { Configuration, PopupRequest } from '@azure/msal-browser'

const clientId = (import.meta.env.VITE_EXTERNAL_CLIENT_ID as string | undefined)
  ?? (import.meta.env.VITE_AZURE_CLIENT_ID as string | undefined)
const externalTenantId = import.meta.env.VITE_EXTERNAL_TENANT_ID as string | undefined
const externalTenantName = import.meta.env.VITE_EXTERNAL_TENANT_NAME as string | undefined
const b2cTenantName = import.meta.env.VITE_AZURE_AD_B2C_TENANT_NAME as string | undefined
const b2cPolicyName = import.meta.env.VITE_AZURE_AD_B2C_POLICY_NAME as string | undefined
const legacyTenantId = import.meta.env.VITE_AZURE_TENANT_ID as string | undefined
const authorityOverride = import.meta.env.VITE_AZURE_AUTHORITY as string | undefined
const knownAuthorityOverride = import.meta.env.VITE_AZURE_KNOWN_AUTHORITY as string | undefined
const apiScope = import.meta.env.VITE_API_SCOPE as string | undefined

const hasExternalIdConfig = Boolean(externalTenantName && externalTenantId)
const hasB2CConfig = Boolean(b2cTenantName && b2cPolicyName)

if (import.meta.env.PROD && (!clientId || (!authorityOverride && !hasB2CConfig && !hasExternalIdConfig))) {
  throw new Error('Azure AD frontend configuration is incomplete (B2C/External ID).')
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
export type { AppRole }