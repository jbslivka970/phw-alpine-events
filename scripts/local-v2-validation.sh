#!/usr/bin/env bash
set -euo pipefail

quick_mode=0
if [[ "${1:-}" == "--quick" ]]; then
  quick_mode=1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backend_url="${BACKEND_BASE_URL:-http://localhost:3001}"

echo "[v2-local] repo=${repo_root}"
echo "[v2-local] backend_url=${backend_url}"
echo "[v2-local] quick_mode=${quick_mode}"

run_step() {
  local label="$1"
  shift
  echo ""
  echo "[v2-local] >>> ${label}"
  "$@"
}

run_step "frontend lint" bash -lc "cd '${repo_root}/frontend' && npm run lint"
run_step "frontend flow tests" bash -lc "cd '${repo_root}/frontend' && npm run test:flows"

run_step "backend typecheck" bash -lc "cd '${repo_root}/backend' && npm run typecheck"
run_step "backend targeted ci tests" bash -lc "cd '${repo_root}/backend' && npm run test:ci -- events.test.ts rsvpService.test.ts notifications.test.ts aiInviteService.test.ts reminderJob.test.ts"

if [[ ${quick_mode} -eq 0 ]]; then
  run_step "backend full test suite with coverage" bash -lc "cd '${repo_root}/backend' && npm run test:coverage:ci"
fi

echo ""
echo "[v2-local] checking backend health before local smoke scripts..."
if curl -fsS --max-time 5 "${backend_url}/api/v1/health" >/dev/null; then
  echo "[v2-local] backend health is up; running local smoke scripts"
  run_step "smoke:email (contract/live-by-env)" bash -lc "cd '${repo_root}' && BACKEND_BASE_URL='${backend_url}' npm --prefix backend run smoke:email"
  run_step "smoke:rsvp (contract/live-by-env)" bash -lc "cd '${repo_root}' && BACKEND_BASE_URL='${backend_url}' npm --prefix backend run smoke:rsvp"
else
  echo "[v2-local] backend not reachable at ${backend_url}; skipping smoke scripts"
  echo "[v2-local] start backend with: cd backend && npm run dev"
fi

if [[ -n "${E2E_API_BASE_URL:-}" && -n "${E2E_APP_URL:-}" ]]; then
  if [[ ${quick_mode} -eq 0 ]]; then
    echo ""
    echo "[v2-local] E2E vars detected; running API role matrix"
    run_step "playwright api role matrix" bash -lc "cd '${repo_root}' && npm run test:e2e:role-matrix"
  else
    echo "[v2-local] quick mode enabled; skipping Playwright role matrix"
  fi
else
  echo ""
  if [[ ${quick_mode} -eq 0 ]]; then
    local_api_base="${E2E_API_BASE_URL:-${backend_url}}"
    local_app_base="${E2E_APP_URL:-http://localhost:5173}"
    echo "[v2-local] E2E vars not set; attempting local Playwright role matrix with bypass auth"
    echo "[v2-local] local_e2e_api_base=${local_api_base}"
    echo "[v2-local] local_e2e_app_base=${local_app_base}"
    run_step "playwright api role matrix (local bypass auth)" bash -lc "cd '${repo_root}' && E2E_LOCAL_AUTH_ENABLED=1 E2E_API_BASE_URL='${local_api_base}' E2E_APP_URL='${local_app_base}' npm run test:e2e:role-matrix"
    run_step "playwright launch smoke (local bypass auth)" bash -lc "cd '${repo_root}' && E2E_LOCAL_AUTH_ENABLED=1 E2E_API_BASE_URL='${local_api_base}' E2E_APP_URL='${local_app_base}' npm run test:e2e:launch-smoke"
    run_step "playwright browser suites (local bypass auth)" bash -lc "cd '${repo_root}' && E2E_LOCAL_AUTH_ENABLED=1 E2E_API_BASE_URL='${local_api_base}' E2E_APP_URL='${local_app_base}' npx playwright test browser-auth-flows.spec.ts browser-persona-flow-matrix.spec.ts browser-postdeploy-smoke.spec.ts"
  else
    echo "[v2-local] E2E_API_BASE_URL / E2E_APP_URL not set; skipping Playwright role matrix"
  fi
fi

echo ""
echo "[v2-local] all selected validation steps completed successfully"
