# Email Deliverability Smoke Runbook

Date: 2026-04-12
Owner: Engineering

## Purpose

Run a repeatable, low-risk check for outbound email deliverability and inbox placement.

This runbook covers:
- DNS/auth checks (SPF, DKIM, DMARC, MX)
- Direct Azure Communication Services (ACS) send checks
- Provider operation status checks
- Fast triage for inbox vs spam/quarantine outcomes

## Prerequisites

- Azure CLI logged into the production subscription
- Access to Key Vault secret `acs-connection-string`
- Test recipients available (at least one non-Google mailbox)

## 1) DNS/Auth Checks

Run:

```bash
dig +short TXT _dmarc.phwcoloradoalpine.org
dig +short TXT _dmarc.mail.phwcoloradoalpine.org
dig +short TXT mail.phwcoloradoalpine.org
dig +short CNAME selector1-azurecomm-prod-net._domainkey.mail.phwcoloradoalpine.org
dig +short CNAME selector2-azurecomm-prod-net._domainkey.mail.phwcoloradoalpine.org
dig +short MX mail.phwcoloradoalpine.org
```

Expected:
- `_dmarc.mail.phwcoloradoalpine.org` exists
- `mail.phwcoloradoalpine.org` has SPF and domain verification TXT values
- DKIM selector CNAME records resolve
- `mail.phwcoloradoalpine.org` has MX if reply handling is required

## 2) ACS Domain Verification State

Run:

```bash
az communication email domain show \
  --resource-group phw-alpine-rg-westus2 \
  --email-service-name phwalpine \
  --domain-name mail.phwcoloradoalpine.org \
  --query "verificationStates" -o json
```

Expected:
- `SPF`: `Verified`
- `DKIM`: `Verified`
- `DKIM2`: `Verified`
- `Domain`: `Verified`
- `DMARC`: may lag behind DNS updates in some cases; treat as advisory if sends are succeeding

## 3) Direct Send Test (Single Recipient)

Run:

```bash
ACS_CONNECTION_STRING=$(az keyvault secret show \
  --id "https://kv-phw-alpine-prod.vault.azure.net/secrets/acs-connection-string/b93d019ec26b4f40b195b89b6ac6273a" \
  --query value -o tsv)

az communication email send \
  --connection-string "$ACS_CONNECTION_STRING" \
  --sender "Scheduler@mail.phwcoloradoalpine.org" \
  --subject "PHW deliverability smoke $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --to "<recipient@example.com>" \
  --text "Plain text deliverability smoke test from PHW Alpine Events." \
  --wait-until completed -o json
```

Expected:
- Response includes an `id` (operation ID)
- `status` is `Succeeded`

## 4) Provider Status Check

Run:

```bash
az communication email status get \
  --connection-string "$ACS_CONNECTION_STRING" \
  --operation-id "<operation-id>" -o json
```

Expected:
- `status`: `Succeeded`
- `error`: `null`

## 5) Confirmation Batch (Multiple Recipients)

Run:

```bash
az communication email send \
  --connection-string "$ACS_CONNECTION_STRING" \
  --sender "Scheduler@mail.phwcoloradoalpine.org" \
  --subject "PHW non-google confirmation batch" \
  --to "jbslivka@criticallydamped.com,jonathan.comyn@projecthealingwaters.org,abomb5800@hotmail.com" \
  --text "Confirmation batch after DNS and reputation fixes." \
  --wait-until completed -o json
```

## Triage Matrix

1. Provider `Succeeded` + Inbox received:
- Delivery path is healthy.

2. Provider `Succeeded` + lands in spam/junk:
- Inbox placement/reputation issue, not app send failure.
- Mark as "Not Spam" and add sender/domain allow rules where possible.

3. Provider `Failed`:
- Investigate provider error details and ACS/domain configuration.

4. No recipient log row in app `notification_log`:
- App did not attempt send to that address; verify member targeting, opt-out status, and workflow conditions.

## Known Good Signals from 2026-04-12

- Custom sender domain test reached inbox for non-Google recipient.
- Non-Google confirmation batch was received in inbox.
- Recent ACS operation IDs returned `Succeeded` for both custom and Azure-managed sender identities.
