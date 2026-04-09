# Required Checks Setup (Branch Protection)

Date: 2026-04-09

GitHub branch protection settings are repository configuration, not code, so they cannot be enforced solely through this repo.

Use this checklist to configure required checks for `main` after the workflow updates in `.github/workflows/ci-cd.yml`.

## Checks to Require on main

1. `build`
2. `deploy`
3. `deploy_frontend`
4. `deploy_backend_smoke`
5. `deploy_frontend_smoke`

## Recommended Settings

1. Require a pull request before merging.
2. Require status checks to pass before merging.
3. Require branches to be up to date before merging.
4. Do not allow bypassing the above requirements except for designated admins.

## Notes

1. `release_smoke` is release-event specific and should not be required for normal pull-request merges.
2. If `deploy_frontend_smoke` is skipped due missing E2E credentials/vars, configure those repository secrets/variables first so the check runs consistently.
