# Application Insights Alert Baseline

Date: 2026-03-27
Owner: Engineering
Scope: LR-12 - Application Insights wiring and alert baselines

## Goal

Establish a minimum production alert baseline so backend incidents are detected quickly and triaged consistently.

## Prerequisites

1. App Service has one of:
- `APPINSIGHTS_INSTRUMENTATIONKEY`
- `APPLICATIONINSIGHTS_CONNECTION_STRING`
2. Backend startup confirms telemetry enabled.
3. `/api/v1/health/startup` returns `checks.telemetryConfigured=true`.

## Baseline Alerts

1. Availability alert
- Signal: availability test failed
- Scope: backend endpoint `/api/v1/health`
- Threshold: 2 failures in 5 minutes
- Severity: Sev2

2. Server error rate alert
- Signal: failed requests (`5xx`)
- Threshold: > 2% over 10 minutes, minimum 50 requests
- Severity: Sev2

3. Exception volume alert
- Signal: exceptions count
- Threshold: > 20 exceptions in 10 minutes
- Severity: Sev2

4. P95 request duration alert
- Signal: request duration
- Threshold: p95 > 2000ms over 15 minutes
- Severity: Sev3

5. Notification failure trend alert
- Signal: traces/logs containing notification send failures
- Query window: 15 minutes
- Threshold: > 10 failed sends
- Severity: Sev2

## Suggested KQL Queries

### Failed Request Percentage

```kusto
requests
| where timestamp > ago(10m)
| summarize total=count(), failed=countif(success == false)
| extend failed_pct = iff(total == 0, 0.0, todouble(failed) / todouble(total) * 100.0)
```

### Exception Volume

```kusto
exceptions
| where timestamp > ago(10m)
| summarize exception_count=count()
```

### Notification Failure Count

```kusto
traces
| where timestamp > ago(15m)
| where message has "notification" and message has_any ("failed", "error")
| summarize failures=count()
```

## Action Group Baseline

- Action group name: `ag-phw-alpine-prod-alerts`
- Channels:
  - Email: on-call distro
  - Teams/Webhook: operations incident channel
- Include runbook link in each alert description.

## Verification Checklist

1. Confirm startup telemetry status:
- `GET /api/v1/health/startup`
2. Trigger a controlled test alert (non-production where possible).
3. Verify action group delivery to all channels.
4. Verify alert auto-resolves when metric returns to normal.

## Runbook Linkage

Each alert should include:
- Service name
- Environment
- Triage owner
- First-step command/checks
- Rollback or mitigation decision tree
