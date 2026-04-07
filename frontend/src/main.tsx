import React from 'react'
import ReactDOM from 'react-dom/client'
import { EventType, PublicClientApplication } from '@azure/msal-browser'
import { MsalProvider } from '@azure/msal-react'
import App from './App.tsx'
import { msalConfig } from './authConfig'
import { authDebugEnabled, authDebugError, authDebugLog, authDebugWarn } from './utils/authDebug'
import './index.css'
import './styles/phw-alpine.css'

const msalInstance = new PublicClientApplication(msalConfig)

function isNoTokenRequestCacheError(error: unknown): boolean {
  const errorLike = error as { errorCode?: string; message?: string } | null
  const code = errorLike?.errorCode?.toLowerCase() ?? ''
  const message = errorLike?.message?.toLowerCase() ?? ''
  return code === 'no_token_request_cache_error' || message.includes('no_token_request_cache_error')
}

async function bootstrap() {
  authDebugLog('bootstrap:start', {
    url: window.location.href,
    hasHash: window.location.hash.length > 0,
    hasSearch: window.location.search.length > 0,
    authDebugEnabled,
  })

  msalInstance.addEventCallback((event) => {
    if (!authDebugEnabled) {
      return
    }

    authDebugLog('msal:event', {
      eventType: event.eventType,
      interactionType: event.interactionType,
      hasPayload: Boolean(event.payload),
      errorCode: event.error?.errorCode,
      errorMessage: event.error?.errorMessage,
    })

    if (event.eventType === EventType.LOGIN_FAILURE || event.eventType === EventType.ACQUIRE_TOKEN_FAILURE) {
      authDebugWarn('msal:event:failure', {
        eventType: event.eventType,
        interactionType: event.interactionType,
        errorCode: event.error?.errorCode,
        errorMessage: event.error?.errorMessage,
      })
    }
  })

  try {
    authDebugLog('bootstrap:initialize:begin')
    await msalInstance.initialize()
    authDebugLog('bootstrap:initialize:done', {
      accountCount: msalInstance.getAllAccounts().length,
    })

    authDebugLog('bootstrap:handleRedirectPromise:begin')
    const redirectResult = await msalInstance.handleRedirectPromise()
    authDebugLog('bootstrap:handleRedirectPromise:done', {
      hasResult: Boolean(redirectResult),
      hasAccount: Boolean(redirectResult?.account),
    })

    if (redirectResult?.account) {
      msalInstance.setActiveAccount(redirectResult.account)
      authDebugLog('bootstrap:setActiveAccount:redirectResult', {
        username: redirectResult.account.username,
      })
    } else {
      const existing = msalInstance.getAllAccounts()
      if (existing.length > 0) {
        msalInstance.setActiveAccount(existing[0])
        authDebugLog('bootstrap:setActiveAccount:existing', {
          username: existing[0].username,
        })
      }
    }
  } catch (error) {
    if (isNoTokenRequestCacheError(error)) {
      // This can happen if a stale callback URL is loaded without a matching in-memory request.
      console.info('[MSAL] Ignoring stale redirect callback without request cache.')
      authDebugWarn('bootstrap:handleRedirectPromise:stale-cache', error)
    } else {
      console.error('[MSAL] Redirect handling failed:', error)
      authDebugError('bootstrap:handleRedirectPromise:error', error)
    }
  }

  authDebugLog('bootstrap:render', {
    accountCount: msalInstance.getAllAccounts().length,
    activeAccount: msalInstance.getActiveAccount()?.username,
  })

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <MsalProvider instance={msalInstance}>
        <App />
      </MsalProvider>
    </React.StrictMode>,
  )
}

void bootstrap()