#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP=""
APP_NAME=""
PLAN_NAME=""
PLAN_SKU="F1"
OS_TYPE="linux"
RUNTIME="NODE|20-lts"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group)
      RESOURCE_GROUP="$2"
      shift 2
      ;;
    --app-name)
      APP_NAME="$2"
      shift 2
      ;;
    --plan-name)
      PLAN_NAME="$2"
      shift 2
      ;;
    --plan-sku)
      PLAN_SKU="$2"
      shift 2
      ;;
    --os)
      OS_TYPE="$2"
      shift 2
      ;;
    --runtime)
      RUNTIME="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$RESOURCE_GROUP" || -z "$APP_NAME" || -z "$PLAN_NAME" ]]; then
  echo "Usage: $0 --resource-group <rg> --app-name <app> --plan-name <plan> [--plan-sku <sku>] [--os <linux|windows>] [--runtime <runtime>]" >&2
  exit 1
fi

if ! az appservice plan show --name "$PLAN_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Creating App Service plan $PLAN_NAME in $RESOURCE_GROUP"
  if [[ "$OS_TYPE" == "linux" ]]; then
    az appservice plan create \
      --name "$PLAN_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --sku "$PLAN_SKU" \
      --is-linux \
      --output none
  else
    az appservice plan create \
      --name "$PLAN_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --sku "$PLAN_SKU" \
      --output none
  fi
fi

if ! az webapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Creating web app $APP_NAME"
  if [[ "$OS_TYPE" == "linux" ]]; then
    az webapp create \
      --resource-group "$RESOURCE_GROUP" \
      --plan "$PLAN_NAME" \
      --name "$APP_NAME" \
      --runtime "$RUNTIME" \
      --output none
  else
    az webapp create \
      --resource-group "$RESOURCE_GROUP" \
      --plan "$PLAN_NAME" \
      --name "$APP_NAME" \
      --output none
  fi
fi

echo "Web app $APP_NAME is ready"
