// Minimal MSAL popup callback entry point.
// This module is loaded by auth/popup-callback.html, which is the popup redirectUri.
//
// MSAL browser v5 uses a BroadcastChannel bridge for popup flows:
//   - The opener calls loginPopup() and waits on a BroadcastChannel keyed to the
//     interaction's state ID.
//   - This page calls broadcastResponseToMainFrame() which reads the auth code from
//     the current URL, broadcasts the raw payload to the opener's BroadcastChannel,
//     then closes the popup window.
//   - The opener's MSAL receives the payload, exchanges the auth code for tokens
//     using the PKCE verifier it stored, and resolves loginPopup().
//
// Do NOT call handleRedirectPromise() here — that would try to exchange the code
// inside the popup (wrong context) and never send the BroadcastChannel message.
import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge'

broadcastResponseToMainFrame().catch(() => {
  // If there is no auth response in the URL (e.g. a direct navigation to this page),
  // broadcastResponseToMainFrame throws. That is harmless — just close the popup.
  setTimeout(() => {
    window.close()
  }, 500)
})
