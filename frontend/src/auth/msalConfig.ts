import { Configuration, PopupRequest } from '@azure/msal-browser';

const tenantName = import.meta.env.VITE_AZURE_AD_B2C_TENANT_NAME || '';
const clientId = import.meta.env.VITE_AZURE_CLIENT_ID || '';
const policyName = import.meta.env.VITE_AZURE_AD_B2C_POLICY_NAME || 'B2C_1_signupsignin';

export const msalConfig: Configuration = {
  auth: {
    clientId,
    authority: `https://${tenantName}.b2clogin.com/${tenantName}.onmicrosoft.com/${policyName}`,
    knownAuthorities: tenantName ? [`${tenantName}.b2clogin.com`] : [],
    redirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: 'localStorage',
    storeAuthStateInCookie: false,
  },
};

export const loginRequest: PopupRequest = {
  scopes: ['openid', 'profile'],
};
