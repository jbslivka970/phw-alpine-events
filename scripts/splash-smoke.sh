#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-${SPLASH_BASE_URL:-https://www.phwcoloradoalpine.org}}"
APP_URL="https://app.phwcoloradoalpine.org"

echo "Running splash smoke against: ${BASE_URL}"

http_code=$(curl -sS -o /tmp/phw-splash-body.html -w "%{http_code}" "$BASE_URL")
if [[ "$http_code" != "200" ]]; then
  echo "FAIL: Expected HTTP 200 from ${BASE_URL}, got ${http_code}"
  exit 1
fi

grep -q "PHW Colorado Alpine Chapter" /tmp/phw-splash-body.html || {
  echo "FAIL: Missing chapter title text"
  exit 1
}

grep -q "Chapter Member Portal" /tmp/phw-splash-body.html || {
  echo "FAIL: Missing CTA text"
  exit 1
}

grep -q "${APP_URL}" /tmp/phw-splash-body.html || {
  echo "FAIL: Missing portal link target ${APP_URL}"
  exit 1
}

# Accept the canonical splash logo filename with optional version suffix.
grep -Eqi 'logo-horizontal-light(-v[0-9]+)?\.png' /tmp/phw-splash-body.html || {
  echo "FAIL: Missing branded logo asset reference"
  exit 1
}

grep -q "property=\"og:title\"" /tmp/phw-splash-body.html || {
  echo "FAIL: Missing Open Graph metadata"
  exit 1
}

echo "PASS: Splash smoke checks succeeded"
