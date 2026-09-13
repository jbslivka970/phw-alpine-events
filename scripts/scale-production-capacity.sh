#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-phw-alpine-rg-westus2}"
PLAN_NAME="${AZURE_APP_SERVICE_PLAN_NAME:-phw-alpine-splash-plan}"
SQL_SERVER="${AZURE_SQL_SERVER_NAME:-phwalpinesql873a}"
SQL_DATABASE="${AZURE_SQL_DATABASE_NAME:-phwalpinedb}"
APP_SKU="${AZURE_APP_SERVICE_PLAN_SKU:-P0v3}"
APP_CAPACITY="${AZURE_APP_SERVICE_PLAN_CAPACITY:-1}"
SQL_OBJECTIVE="${AZURE_SQL_SERVICE_OBJECTIVE:-S2}"
SQL_MAX_SIZE="${AZURE_SQL_MAX_SIZE:-20GB}"
APPLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=1
      shift
      ;;
    --app-sku)
      APP_SKU="$2"
      shift 2
      ;;
    --app-capacity)
      APP_CAPACITY="$2"
      shift 2
      ;;
    --sql-objective)
      SQL_OBJECTIVE="$2"
      shift 2
      ;;
    --sql-max-size)
      SQL_MAX_SIZE="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

command -v az >/dev/null 2>&1 || { echo "Azure CLI is required." >&2; exit 1; }
az account show --query '{subscription:name,user:user.name}' --output table

echo
echo "Current capacity:"
az appservice plan show --resource-group "$RESOURCE_GROUP" --name "$PLAN_NAME" \
  --query '{name:name,sku:sku.name,tier:sku.tier,capacity:sku.capacity}' --output table
az sql db show --resource-group "$RESOURCE_GROUP" --server "$SQL_SERVER" --name "$SQL_DATABASE" \
  --query '{name:name,sku:sku.name,tier:sku.tier,capacity:sku.capacity,maxSizeBytes:maxSizeBytes}' --output table

echo
echo "Requested capacity: App Service $APP_SKU x $APP_CAPACITY; Azure SQL $SQL_OBJECTIVE, max size $SQL_MAX_SIZE"

if [[ "$APPLY" != "1" ]]; then
  echo "Dry run only. Re-run with PRODUCTION_CHANGE_APPROVED=1 and --apply during an approved change window."
  exit 0
fi

if [[ "${PRODUCTION_CHANGE_APPROVED:-0}" != "1" ]]; then
  echo "Refusing production changes without PRODUCTION_CHANGE_APPROVED=1." >&2
  exit 1
fi

az appservice plan update \
  --resource-group "$RESOURCE_GROUP" \
  --name "$PLAN_NAME" \
  --sku "$APP_SKU" \
  --number-of-workers "$APP_CAPACITY" \
  --output table

az sql db update \
  --resource-group "$RESOURCE_GROUP" \
  --server "$SQL_SERVER" \
  --name "$SQL_DATABASE" \
  --service-objective "$SQL_OBJECTIVE" \
  --max-size "$SQL_MAX_SIZE" \
  --output table

echo
echo "Capacity update submitted. Run the health, latency, and DTU checks in docs/colorado-springs-onboarding-runbook.md."