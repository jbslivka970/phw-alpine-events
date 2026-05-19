# Release Evidence Handoff

Date: 2026-05-19

## Purpose

Provide a repeatable tidy-in process for deployment evidence so release notes and audit requests can be answered without manual log hunting.

## What is retained automatically

1. Playwright artifacts on failure for API and browser E2E jobs.
2. Backend post-deploy smoke logs artifact: `deploy-backend-smoke-logs-<run_id>`.
3. Frontend post-deploy smoke logs artifact: `deploy-frontend-smoke-logs-<run_id>`.

## Operator tidy-in checklist (per deployment)

1. Capture the run URL and SHA in release notes.
2. Capture job URLs for `build`, `deploy`, `deploy_frontend`, `deploy_backend_smoke`, and `deploy_frontend_smoke`.
3. Record artifact inventory (`total_count` and artifact names).
4. If no artifacts were created, note that logs are the source of truth.
5. Add any warnings (for example stale live RSVP token warning) to the release notes.

## Commands

```bash
GH_PAGER=cat gh run list --branch main --workflow "CI/CD Pipeline" --limit 1 --json databaseId,headSha,url,status,conclusion
```

```bash
GH_PAGER=cat gh run view <RUN_ID> --json jobs --jq '.jobs[] | {name, conclusion, url}'
```

```bash
GH_PAGER=cat gh api repos/jbslivka970/phw-alpine-events/actions/runs/<RUN_ID>/artifacts --jq '{total_count: .total_count, names: [.artifacts[].name]}'
```

## Notes

1. For this repository, generated zip/screenshot artifacts are archived outside the repository and removed from git tracking.
2. Keep retention settings in workflow artifact steps aligned with release/compliance policy.
