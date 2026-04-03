#!/usr/bin/env bash
set -euo pipefail

# Purchase and lock PHW domains in Azure App Service Domains.
#
# Usage:
#   ./scripts/purchase-domains-azure.sh \
#     --resource-group phw-alpine-rg-westus2 \
#     --contact-info ./scripts/domain-contact-info.json \
#     --execute
#
# By default this script runs dry-run previews only.

RESOURCE_GROUP=""
CONTACT_INFO=""
EXECUTE="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group)
      RESOURCE_GROUP="$2"
      shift 2
      ;;
    --contact-info)
      CONTACT_INFO="$2"
      shift 2
      ;;
    --execute)
      EXECUTE="true"
      shift 1
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$RESOURCE_GROUP" || -z "$CONTACT_INFO" ]]; then
  echo "Usage: $0 --resource-group <rg> --contact-info <path> [--execute]" >&2
  exit 1
fi

if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI is required." >&2
  exit 1
fi

if [[ ! -f "$CONTACT_INFO" ]]; then
  echo "Contact info file not found: $CONTACT_INFO" >&2
  exit 1
fi

declare -a DOMAINS=(
  "phwcoloradoalpine.org"
  "phwcoloradoalpine.com"
)

echo "Checking purchase terms and availability..."
for domain in "${DOMAINS[@]}"; do
  az appservice domain show-terms --hostname "$domain" \
    --query '{hostname:hostname,available:hostname_available,price:hostname_purchase_price}' -o json
  echo

done

if [[ "$EXECUTE" != "true" ]]; then
  echo "Running dry-run purchase previews (no purchase will occur)."
  for domain in "${DOMAINS[@]}"; do
    az appservice domain create \
      --resource-group "$RESOURCE_GROUP" \
      --hostname "$domain" \
      --contact-info @"$CONTACT_INFO" \
      --dryrun \
      --query '{hostname:hostname,provisioningState:provisioningState,createdHostNames:managedHostNames}' -o json || true
    echo
  done
  echo "Dry-run complete. Re-run with --execute to purchase both domains."
  exit 0
fi

echo "Purchasing domains..."
for domain in "${DOMAINS[@]}"; do
  az appservice domain create \
    --resource-group "$RESOURCE_GROUP" \
    --hostname "$domain" \
    --contact-info @"$CONTACT_INFO" \
    --accept-terms \
    --privacy true \
    --auto-renew true \
    --query '{hostname:hostname,provisioningState:provisioningState}' -o json
  echo

done

echo "Done. Domains requested: ${DOMAINS[*]}"
