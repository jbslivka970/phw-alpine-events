#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-}"
PLAN_NAME="${AZURE_APP_SERVICE_PLAN_NAME:-}"
SKU="${AZURE_APP_SERVICE_PLAN_SKU:-B1}"
CAPACITY="${AZURE_APP_SERVICE_PLAN_CAPACITY:-1}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group)
      RESOURCE_GROUP="$2"
      shift 2
      ;;
    --plan-name)
      PLAN_NAME="$2"
      shift 2
      ;;
    --sku)
      SKU="$2"
      shift 2
      ;;
    --capacity)
      CAPACITY="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$RESOURCE_GROUP" || -z "$PLAN_NAME" ]]; then
  echo "Usage: $0 --resource-group <rg> --plan-name <plan> [--sku <sku>] [--capacity <n>]" >&2
  exit 1
fi

echo "Scaling App Service plan $PLAN_NAME in resource group $RESOURCE_GROUP to SKU $SKU / capacity $CAPACITY"

az appservice plan update \
  --name "$PLAN_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --sku "$SKU" \
  --number-of-workers "$CAPACITY" \
  --output table
