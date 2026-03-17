#!/usr/bin/env bash
set -euo pipefail

# Configure backend and frontend auth settings in Azure App Service for
# Microsoft Entra External ID (or existing B2C-compatible configuration).
#
# Usage:
#   ./scripts/configure-external-id-appsettings.sh \
#     --resource-group phw-alpine-rg-westus2 \
#     --webapp phwalpineeventsjb873a \
#     --tenant-name mytenant \
#     --tenant-id 00000000-0000-0000-0000-000000000000 \
#     --backend-client-id 11111111-1111-1111-1111-111111111111 \
#     --frontend-client-id 22222222-2222-2222-2222-222222222222 \
#     --authority https://mytenant.ciamlogin.com/mytenant.onmicrosoft.com \
#     --issuer https://mytenant.ciamlogin.com/00000000-0000-0000-0000-000000000000/v2.0/ \
#     --jwks-uri https://mytenant.ciamlogin.com/00000000-0000-0000-0000-000000000000/discovery/v2.0/keys \
#     --policy-name B2C_1_signupsignin

RESOURCE_GROUP=""
WEBAPP_NAME=""
TENANT_NAME=""
TENANT_ID=""
BACKEND_CLIENT_ID=""
FRONTEND_CLIENT_ID=""
AUTHORITY_URL=""
ISSUER_URL=""
JWKS_URI=""
POLICY_NAME="B2C_1_signupsignin"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group)
      RESOURCE_GROUP="$2"
      shift 2
      ;;
    --webapp)
      WEBAPP_NAME="$2"
      shift 2
      ;;
    --tenant-name)
      TENANT_NAME="$2"
      shift 2
      ;;
    --tenant-id)
      TENANT_ID="$2"
      shift 2
      ;;
    --backend-client-id)
      BACKEND_CLIENT_ID="$2"
      shift 2
      ;;
    --frontend-client-id)
      FRONTEND_CLIENT_ID="$2"
      shift 2
      ;;
    --authority)
      AUTHORITY_URL="$2"
      shift 2
      ;;
    --issuer)
      ISSUER_URL="$2"
      shift 2
      ;;
    --jwks-uri)
      JWKS_URI="$2"
      shift 2
      ;;
    --policy-name)
      POLICY_NAME="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

for required in RESOURCE_GROUP WEBAPP_NAME TENANT_NAME TENANT_ID BACKEND_CLIENT_ID FRONTEND_CLIENT_ID AUTHORITY_URL ISSUER_URL JWKS_URI; do
  if [[ -z "${!required}" ]]; then
    echo "Missing required value: ${required}" >&2
    exit 1
  fi
done

echo "Applying External ID backend auth settings to App Service ${WEBAPP_NAME}..."
az webapp config appsettings set \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${WEBAPP_NAME}" \
  --settings \
    AZURE_EXTERNAL_TENANT_NAME="${TENANT_NAME}" \
    AZURE_EXTERNAL_TENANT_ID="${TENANT_ID}" \
    AZURE_CLIENT_ID="${BACKEND_CLIENT_ID}" \
    AZURE_EXTERNAL_USER_FLOW="${POLICY_NAME}" \
    AZURE_AUTH_ISSUER="${ISSUER_URL}" \
    AZURE_AUTH_JWKS_URI="${JWKS_URI}" \
    CORS_ORIGIN="https://${WEBAPP_NAME}.azurewebsites.net" \
  >/dev/null

echo "Backend auth settings updated."
echo
echo "Set these frontend values in your frontend host:"
echo "VITE_EXTERNAL_TENANT_NAME=${TENANT_NAME}"
echo "VITE_EXTERNAL_TENANT_ID=${TENANT_ID}"
echo "VITE_EXTERNAL_CLIENT_ID=${FRONTEND_CLIENT_ID}"
echo "VITE_EXTERNAL_USER_FLOW=${POLICY_NAME}"
echo "VITE_AZURE_AUTHORITY=${AUTHORITY_URL}/${POLICY_NAME}"
echo "VITE_AZURE_KNOWN_AUTHORITY=$(echo "${AUTHORITY_URL}" | sed -E 's#https?://([^/]+).*#\1#')"
echo "VITE_API_BASE_URL=https://${WEBAPP_NAME}.azurewebsites.net/api/v1"
echo
echo "Run smoke checks:"
echo "  curl -sS https://${WEBAPP_NAME}.azurewebsites.net/api/v1/health/startup"
echo "  curl -sS -i https://${WEBAPP_NAME}.azurewebsites.net/api/v1/events | head -n 20"
