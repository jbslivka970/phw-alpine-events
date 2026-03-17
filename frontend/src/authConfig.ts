import { Configuration, PopupRequest } from '@azure/msal-browser';

const clientId = import.meta.env.VITE_AZURE_CLIENT_ID as string | undefined;
const tenantId = import.meta.env.VITE_AZURE_TENANT_ID as string | undefined;
const authorityOverride = import.meta.env.VITE_AZURE_AUTHORITY as string | undefined;

if (!clientId && import.meta.env.PROD) {
  throw new Error('VITE_AZURE_CLIENT_ID is required – check your environment variables.');
}

const authority =
  authorityOverride ||
  (tenantId
    ? `https://login.microsoftonline.com/${tenantId}`
    : 'https://login.microsoftonline.com/common');

export const msalConfig: Configuration = {
  auth: {
    clientId: clientId ?? 'dev-placeholder-client-id',
    authority,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
    navigateToLoginRequestUrl: true,
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
};

export const loginRequest: PopupRequest = {
  scopes: ['openid', 'profile', 'email'],
};

/** Role constants – must match the roles defined in Azure AD B2C app manifest */
export const ROLES = {
  ADMIN: 'Admin',
  STAFF: 'Staff',
  MEMBER: 'Member',
} as const;

export type AppRole = (typeof ROLES)[keyof typeof ROLES];
