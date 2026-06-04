#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "[release:db-backup-export] Missing required env var: $name"
    exit 1
  fi
}

if ! command -v az >/dev/null 2>&1; then
  echo "[release:db-backup-export] Azure CLI (az) is required."
  exit 1
fi

require_env AZURE_SQL_RESOURCE_GROUP
require_env AZURE_SQL_SERVER
require_env AZURE_SQL_DATABASE
require_env AZURE_STORAGE_URI
require_env AZURE_STORAGE_KEY
require_env SQL_ADMIN_USER
require_env SQL_ADMIN_PASSWORD

if [[ -n "${AZURE_SUBSCRIPTION_ID:-}" ]]; then
  az account set --subscription "$AZURE_SUBSCRIPTION_ID"
fi

echo "[release:db-backup-export] Starting BACPAC export for ${AZURE_SQL_SERVER}/${AZURE_SQL_DATABASE}"

az sql db export \
  --resource-group "$AZURE_SQL_RESOURCE_GROUP" \
  --server "$AZURE_SQL_SERVER" \
  --name "$AZURE_SQL_DATABASE" \
  --storage-key-type StorageAccessKey \
  --storage-key "$AZURE_STORAGE_KEY" \
  --storage-uri "$AZURE_STORAGE_URI" \
  --admin-user "$SQL_ADMIN_USER" \
  --admin-password "$SQL_ADMIN_PASSWORD"

echo "[release:db-backup-export] Export request submitted."
echo "[release:db-backup-export] Verify BACPAC at: $AZURE_STORAGE_URI"
