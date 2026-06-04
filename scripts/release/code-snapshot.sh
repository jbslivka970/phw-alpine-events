#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[release:code-snapshot] Not inside a git repository."
  exit 1
fi

RELEASE_VERSION="${1:-${RELEASE_VERSION:-manual}}"
TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
SHORT_SHA="$(git rev-parse --short HEAD)"
BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD)"
OUT_DIR="$ROOT_DIR/artifacts/release"
BASE_NAME="code-snapshot-v${RELEASE_VERSION}-${TIMESTAMP}-${SHORT_SHA}"

mkdir -p "$OUT_DIR"

BUNDLE_PATH="$OUT_DIR/${BASE_NAME}.bundle"
ARCHIVE_PATH="$OUT_DIR/${BASE_NAME}.zip"
MANIFEST_PATH="$OUT_DIR/${BASE_NAME}.manifest.txt"

# Bundle keeps full git history and is restorable with git clone repo.bundle.
git bundle create "$BUNDLE_PATH" --all

# Archive captures a clean source snapshot for quick inspection or restore prep.
git archive --format=zip --output "$ARCHIVE_PATH" HEAD

{
  echo "release_version=v${RELEASE_VERSION}"
  echo "timestamp_utc=${TIMESTAMP}"
  echo "commit_sha=$(git rev-parse HEAD)"
  echo "branch=${BRANCH_NAME}"
  echo "bundle_path=${BUNDLE_PATH}"
  echo "archive_path=${ARCHIVE_PATH}"
} > "$MANIFEST_PATH"

echo "[release:code-snapshot] Created:"
echo "- $BUNDLE_PATH"
echo "- $ARCHIVE_PATH"
echo "- $MANIFEST_PATH"
