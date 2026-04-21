# PHW Alpine Events - Production-Verified Findings and Cleanup Backlog

| Field | Value |
|---|---|
| Date | 2026-04-21 |
| Environment Verified | Production App Service `phwalpineeventsjb873a` |
| Verification Sources | Production `/api/v1/health/startup`, Azure App Service settings metadata, current repository code |
| Purpose | Separate active production findings from code-only or documentation-only concerns, then convert them into an implementation backlog |

## 1. Executive Summary

Production is materially more hardened than several earlier review statements implied.

Live verification confirmed that production is running in `nodeEnv=production`, startup health returns `status=ok`, notifications are in `real` mode for both email and SMS, telemetry is configured, and Key Vault references are both required and currently detected by the application.

That downgrades three broad concerns from the earlier review:

1. Production is not currently running in stub notification mode.
2. Key Vault is not absent in production for the core secrets that were checked.
3. Telemetry is not absent in production.

The remaining meaningful findings are narrower:

1. Production is not fail-closed for notifications because `NOTIFICATIONS_STRICT_MODE` is absent.
2. Reporting and startup health semantics still understate notification risk if providers regress.
3. Frontend ADA gaps remain live regardless of backend hardening.
4. Repository and operator-path hygiene issues remain implementation backlog items.

## 2. Production Verification Snapshot

### 2.1 Live Health Result

| Check | Result |
|---|---|
| HTTP status | 200 |
| Startup summary status | `ok` |
| Runtime environment | `production` |
| Notification mode | `real` |
| Email notification channel | `real` |
| SMS notification channel | `real` |
| Notifications configured | `true` |
| Notification strict mode | `false` |
| Key Vault references configured | `true` |
| Require Key Vault references | `true` |
| Telemetry configured | `true` |

### 2.2 App Setting Verification

The following results were captured without printing any secret values.

| Setting | Verified State | Interpretation |
|---|---|---|
| `ACS_CONNECTION_STRING` | `kv-reference-present` | Production email provider secret is Key Vault-backed |
| `ACS_EMAIL_FROM` | `present` | Email sender is explicitly configured |
| `TELNYX_API_KEY` | `kv-reference-present` | Production SMS provider secret is Key Vault-backed |
| `TELNYX_MESSAGING_PROFILE_ID` | `present` | Telnyx routing is configured |
| `TELNYX_FROM_NUMBER` | `present` | SMS sender is configured |
| `RSVP_TOKEN_SECRET` | `kv-reference-present` | Core RSVP token secret is Key Vault-backed |
| `EMAIL_PREFERENCE_TOKEN_SECRET` | `absent` | Unsubscribe token flow falls back to the RSVP token secret |
| `REQUIRE_KEYVAULT_REFERENCES` | `true` | Production policy requires Key Vault references |
| `NOTIFICATIONS_STRICT_MODE` | `absent` | Fail-closed notification enforcement is not enabled |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | `present` | Telemetry is configured |
| `APPINSIGHTS_INSTRUMENTATIONKEY` | `present` | Legacy App Insights key is also present |
| `TWILIO_*` | `absent` | Production is using Telnyx rather than Twilio |
| `E2E_LOCAL_AUTH_ENABLED` | `absent` | No evidence of production local-auth bypass setting |
| `PUBLIC_API_BASE_URL` | `absent` | Not treated as a production issue on its own |

`WEBSITE_HOSTNAME` is platform-injected by App Service and is not expected to appear in the explicit app settings list. Its absence from that list is not evidence that it is unavailable at runtime.

## 3. Findings Still Active After Production Verification

| Severity | Status | Finding | Why It Still Matters | Implementation Direction |
|---|---|---|---|---|
| High | Active in prod UI | Calendar month view lacks accessible grid semantics and event open behavior is generic | ADA/WCAG exposure remains live in the deployed frontend; backend hardening does not mitigate it | Rebuild month grid semantics and make event open actions event-specific |
| High | Active in prod UI | Event modal labeling and focus-management are incomplete | Keyboard and screen-reader behavior remains below expected accessibility standards | Add focus trap/Escape support and explicit `htmlFor`/`id` bindings |
| Medium | Active in prod runtime | `NOTIFICATIONS_STRICT_MODE` is not enabled | Production is healthy today, but provider regression can still degrade to stub or partial mode without fail-closed behavior | Enable strict mode in production |
| Medium | Active in prod runtime | Startup health can still report `ok` when notifications are degraded if strict mode stays off | Monitoring can understate delivery risk during future drift or outages | Degrade production startup health for non-real notification mode, or make strict mode mandatory |
| Medium | Active in code and prod reporting | Delivery reports count `stubbed` as successful | Future incidents could be masked in dashboards, exports, and compliance evidence | Split `stubbed` from true success in reporting and coverage logic |
| Low | Active in prod config | `EMAIL_PREFERENCE_TOKEN_SECRET` is absent, so unsubscribe links reuse `RSVP_TOKEN_SECRET` | The shared-secret fallback works, but increases blast radius and rotation coupling | Add a dedicated unsubscribe token secret via Key Vault |
| Medium | Active in repo / release process | Tracked release archives and screenshots remain in Git | This is not a runtime production outage, but it is still a real hygiene and disclosure risk | Remove tracked artifacts and extend ignore rules |
| Medium | Active in operator tooling | `scripts/run-migration.js` still reads local env and shells out with composed values | Privileged maintenance tooling remains less safe than the production runtime | Replace with explicit env/CLI input and argument-safe execution |
| Medium | Active in ops evidence | App Insights alert delivery verification is still incomplete | Telemetry is configured, but alert proof and action-group evidence remain process risk | Verify alert routing end-to-end and capture evidence |

## 4. Findings Downgraded by Production Verification

These should not be treated as active production failures based on the current evidence gathered on 2026-04-21.

| Earlier Concern | Production Verification Result | Revised Interpretation |
|---|---|---|
| Notification providers may be missing in production | Startup health reports `notificationMode=real`, `emailNotificationChannel=real`, `smsNotificationChannel=real` | Not an active prod outage; keep as fail-closed hardening work, not a current incident |
| Key Vault rollout is absent in production | Production requires Key Vault references and core checked secrets are Key Vault-backed | Broad "Key Vault missing" language is too strong; remaining work is completeness, documentation, and evidence |
| Telemetry may be absent in production | Startup health reports `telemetryConfigured=true`; App Insights settings are present | This is not an active prod gap; the remaining issue is alert-policy verification |
| Local E2E auth bypass could leak into production | Setting was not present, and code also gates local auth to non-production runtime | Treat as mitigated by current prod config and code guard |
| `PUBLIC_API_BASE_URL` absence breaks prod unsubscribe links | No direct evidence of failure, and production can derive host info from platform runtime env | Do not treat missing explicit app setting as a prod finding by itself |

## 5. Cleanup Pass for Implementation

### 5.1 P0 - Immediate Changes

1. Enable `NOTIFICATIONS_STRICT_MODE` in production and validate startup/notification behavior.
2. Add `EMAIL_PREFERENCE_TOKEN_SECRET` as a dedicated Key Vault-backed setting.
3. Remove `stubbed` from success/delivery counts and make production health degrade on non-real delivery mode.
4. Remove tracked archives/screenshots from version control and add explicit ignore coverage for exact filenames still slipping through.

### 5.2 P1 - Accessibility Remediation

1. Replace the calendar month view with accessible calendar/grid semantics.
2. Make calendar event activation open a specific event context.
3. Add robust dialog focus handling plus bound labels/ids in the event modal.
4. Add explicit labels in TemplatesPage and AdminPage, plus captions and scoped headers in ImportPage.
5. Run a contrast audit on RSVP/status color tokens.

### 5.3 P1 - Ops and Documentation Cleanup

1. Harden or retire `scripts/run-migration.js`.
2. Verify App Insights alerting end-to-end and document the evidence.
3. Update Key Vault documentation to reflect that production already has partial/core rollout in place.
4. Keep one source-of-truth findings/backlog artifact rather than spreading status across stale April documents.

## 6. Recommended Positioning for the Next Implementation Pass

Treat this document as the implementation-facing findings list.

Treat `docs/prd-v1_2-reconciliation-20260421.md` as the broader product/status reconciliation artifact.