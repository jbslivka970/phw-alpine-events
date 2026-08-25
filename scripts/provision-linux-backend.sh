#!/usr/bin/env bash
# Provisions a right-sized Linux App Service plan + web app for the backend.
# A Windows plan cannot be converted to Linux in place, so cutover requires a new plan.
set -euo pipefail

RESOURCE_GROUP="${AZURE_BACKEND_RESOURCE_GROUP:-}"
PLAN_NAME="${AZURE_LINUX_PLAN_NAME:-}"
WEBAPP_NAME="${AZURE_LINUX_WEBAPP_NAME:-}"
SKU="${AZURE_LINUX_PLAN_SKU:-B1}"
CAPACITY="${AZURE_LINUX_PLAN_CAPACITY:-1}"
NODE_VERSION="${AZURE_LINUX_NODE_VERSION:-24-lts}"
LOCATION="${AZURE_LINUX_LOCATION:-}"
COPY_SETTINGS_FROM="${AZURE_SOURCE_WEBAPP_NAME:-}"
KEY_VAULT_NAME="${AZURE_KEY_VAULT_NAME:-}"

usage() {
  cat >&2 <<'USAGE'
Usage: provision-linux-backend.sh --resource-group <rg> --plan-name <plan> --webapp-name <app> [options]

Options:
  --sku <sku>                 Plan SKU (default: B1)
  --capacity <n>              Worker count (default: 1)
  --node-version <ver>        Linux Node runtime (default: 24-lts)
  --location <region>         Azure region (default: resource group location)
  --copy-settings-from <app>  Copy app settings from an existing web app
  --key-vault-name <vault>    Grant the web app get/list access to vault secrets
  --dry-run                   Print the actions without applying them
USAGE
  exit 2
}

DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group) RESOURCE_GROUP="$2"; shift 2 ;;
    --plan-name) PLAN_NAME="$2"; shift 2 ;;
    --webapp-name) WEBAPP_NAME="$2"; shift 2 ;;
    --sku) SKU="$2"; shift 2 ;;
    --capacity) CAPACITY="$2"; shift 2 ;;
    --node-version) NODE_VERSION="$2"; shift 2 ;;
    --location) LOCATION="$2"; shift 2 ;;
    --copy-settings-from) COPY_SETTINGS_FROM="$2"; shift 2 ;;
    --key-vault-name) KEY_VAULT_NAME="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

if [[ -z "$RESOURCE_GROUP" || -z "$PLAN_NAME" || -z "$WEBAPP_NAME" ]]; then
  usage
fi

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "DRY-RUN: $*"
  else
    "$@"
  fi
}

if [[ -z "$LOCATION" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    LOCATION="<resource-group-location>"
  else
    LOCATION="$(az group show --name "$RESOURCE_GROUP" --query location -o tsv)"
  fi
fi

echo "Provisioning Linux backend"
echo "  resource group : $RESOURCE_GROUP"
echo "  location       : $LOCATION"
echo "  plan           : $PLAN_NAME ($SKU x $CAPACITY, Linux)"
echo "  web app        : $WEBAPP_NAME (NODE|$NODE_VERSION)"

run az appservice plan create \
  --name "$PLAN_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --is-linux \
  --sku "$SKU" \
  --number-of-workers "$CAPACITY" \
  --output none

run az webapp create \
  --name "$WEBAPP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --plan "$PLAN_NAME" \
  --runtime "NODE|$NODE_VERSION" \
  --output none

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY-RUN: enable system-assigned identity for $WEBAPP_NAME"
  echo "DRY-RUN: grant Website Contributor on $WEBAPP_NAME to its identity"
  if [[ -n "$KEY_VAULT_NAME" ]]; then
    echo "DRY-RUN: grant get/list secret access on $KEY_VAULT_NAME to the web app identity"
  fi
else
  PRINCIPAL_ID="$(az webapp identity assign \
    --name "$WEBAPP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query principalId \
    --output tsv)"
  SITE_ID="$(az webapp show \
    --name "$WEBAPP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query id \
    --output tsv)"

  az role assignment create \
    --assignee-object-id "$PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "Website Contributor" \
    --scope "$SITE_ID" \
    --output none

  if [[ -n "$KEY_VAULT_NAME" ]]; then
    VAULT_USES_RBAC="$(az keyvault show \
      --name "$KEY_VAULT_NAME" \
      --query properties.enableRbacAuthorization \
      --output tsv)"
    if [[ "$VAULT_USES_RBAC" == "true" ]]; then
      VAULT_ID="$(az keyvault show --name "$KEY_VAULT_NAME" --query id --output tsv)"
      az role assignment create \
        --assignee-object-id "$PRINCIPAL_ID" \
        --assignee-principal-type ServicePrincipal \
        --role "Key Vault Secrets User" \
        --scope "$VAULT_ID" \
        --output none
    else
      az keyvault set-policy \
        --name "$KEY_VAULT_NAME" \
        --object-id "$PRINCIPAL_ID" \
        --secret-permissions get list \
        --output none
    fi
  fi
fi

run az webapp config set \
  --name "$WEBAPP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --startup-file "node server.js" \
  --min-tls-version 1.2 \
  --ftps-state Disabled \
  --always-on true \
  --output none

run az webapp update \
  --name "$WEBAPP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --https-only true \
  --output none

run az webapp config appsettings set \
  --name "$WEBAPP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --settings SCM_DO_BUILD_DURING_DEPLOYMENT=false ENABLE_ORYX_BUILD=false \
  --output none

if [[ -n "$COPY_SETTINGS_FROM" ]]; then
  echo "Copying app settings from $COPY_SETTINGS_FROM (values are not printed)."

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "DRY-RUN: copy app settings from $COPY_SETTINGS_FROM to $WEBAPP_NAME"
  else
    SETTINGS_FILE="$(mktemp)"
    chmod 600 "$SETTINGS_FILE"
    trap 'rm -f "$SETTINGS_FILE"' EXIT

    az webapp config appsettings list \
      --name "$COPY_SETTINGS_FROM" \
      --resource-group "$RESOURCE_GROUP" \
      --output json > "$SETTINGS_FILE"

    COPIED=()
    while IFS= read -r pair; do
      [[ -n "$pair" ]] && COPIED+=("$pair")
    done < <(python3 - "$SETTINGS_FILE" <<'PY'
import json
import sys

# WEBSITE_NODE_DEFAULT_VERSION is Windows-only and breaks the Linux runtime stack.
SKIP = {"WEBSITE_NODE_DEFAULT_VERSION", "WEBSITE_RUN_FROM_PACKAGE"}

with open(sys.argv[1], encoding="utf-8") as handle:
    for item in json.load(handle):
        name = item.get("name") or ""
        value = item.get("value")
        if not name or name in SKIP or value is None:
            continue
        print(f"{name}={value}")
PY
)

    if [[ "${#COPIED[@]}" -gt 0 ]]; then
      az webapp config appsettings set \
        --name "$WEBAPP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --settings "${COPIED[@]}" \
        --output none
      echo "Copied ${#COPIED[@]} app setting(s)."
    else
      echo "No app settings found to copy."
    fi
  fi
fi

echo
echo "Next steps:"
echo "  1. Set repo variable BACKEND_APP_SERVICE_OS=linux"
echo "  2. Set repo variable AZURE_WEBAPP_NAME=$WEBAPP_NAME"
echo "  3. Set repo variable AZURE_APP_SERVICE_PLAN_NAME=$PLAN_NAME"
echo "  4. Deploy, verify /api/v1/health, then delete the old Windows plan."
