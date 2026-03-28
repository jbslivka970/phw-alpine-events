#!/usr/bin/env bash
set -euo pipefail

# Provisions test Entra ID users and app-role assignments for this app.
#
# Required:
#   --tenant-id   Tenant ID that owns the app registration
#   --app-id      Client ID (application ID) containing appRoles ADMIN/EVENT_CREATOR/USER
#   --domain      Verified tenant domain for user principal names (example: contoso.onmicrosoft.com)
#
# Optional:
#   --prefix      Username prefix (default: phw-smoke)
#
# Example:
#   ./scripts/provision-rbac-test-users.sh \
#     --tenant-id d65d23ea-9a90-4080-b5ab-f427665cbfcf \
#     --app-id b5efba73-84dc-4bd3-a7ac-edd6fcbf910b \
#     --domain phwalpine.onmicrosoft.com \
#     --prefix phw-test

TENANT_ID=""
APP_ID=""
DOMAIN=""
PREFIX="phw-smoke"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant-id)
      TENANT_ID="$2"
      shift 2
      ;;
    --app-id)
      APP_ID="$2"
      shift 2
      ;;
    --domain)
      DOMAIN="$2"
      shift 2
      ;;
    --prefix)
      PREFIX="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$TENANT_ID" || -z "$APP_ID" || -z "$DOMAIN" ]]; then
  echo "Missing required args."
  echo "Usage: $0 --tenant-id <tenant> --app-id <client-id> --domain <tenant-domain> [--prefix <prefix>]"
  exit 1
fi

if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI (az) is required."
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required for password generation."
  exit 1
fi

echo "Ensuring Azure CLI is authenticated for tenant $TENANT_ID ..."
az account show >/dev/null 2>&1 || true
# This may open browser/device login if needed.
az login --tenant "$TENANT_ID" --allow-no-subscriptions -o none

SP_ID="$(az ad sp show --id "$APP_ID" --query id -o tsv)"
if [[ -z "$SP_ID" ]]; then
  echo "Unable to find service principal for app-id $APP_ID"
  exit 1
fi

get_role_id() {
  local role_value="$1"
  az ad sp show --id "$APP_ID" --query "appRoles[?value=='$role_value'].id | [0]" -o tsv
}

ADMIN_ROLE_ID="$(get_role_id ADMIN)"
EVENT_CREATOR_ROLE_ID="$(get_role_id EVENT_CREATOR)"
USER_ROLE_ID="$(get_role_id USER)"

if [[ -z "$ADMIN_ROLE_ID" || -z "$EVENT_CREATOR_ROLE_ID" || -z "$USER_ROLE_ID" ]]; then
  echo "Could not resolve one or more app role IDs (ADMIN, EVENT_CREATOR, USER)."
  echo "Verify app-id points to the app registration that defines these roles."
  exit 1
fi

create_or_get_user_id() {
  local upn="$1"
  local display_name="$2"
  local password="$3"

  local existing
  existing="$(az ad user list --filter "userPrincipalName eq '$upn'" --query "[0].id" -o tsv)"
  if [[ -n "$existing" ]]; then
    echo "$existing"
    return
  fi

  az ad user create \
    --display-name "$display_name" \
    --user-principal-name "$upn" \
    --password "$password" \
    --force-change-password-next-sign-in true \
    --query id -o tsv
}

assign_app_role_if_missing() {
  local principal_id="$1"
  local app_role_id="$2"

  local existing
  existing="$(az rest \
    --method GET \
    --url "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/appRoleAssignedTo?\$filter=principalId%20eq%20$principal_id" \
    --query "value[?appRoleId=='$app_role_id'] | length(@)" -o tsv 2>/dev/null || echo "0")"

  if [[ "$existing" != "0" ]]; then
    return
  fi

  az rest \
    --method POST \
    --url "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/appRoleAssignedTo" \
    --body "{\"principalId\":\"$principal_id\",\"resourceId\":\"$SP_ID\",\"appRoleId\":\"$app_role_id\"}" \
    -o none
}

mk_password() {
  # Meets common complexity patterns: upper/lower/digit/symbol, length > 16.
  printf 'Phw-%s!aA9' "$(openssl rand -hex 6)"
}

ADMIN_UPN="$PREFIX-admin@$DOMAIN"
CREATOR_UPN="$PREFIX-eventcreator@$DOMAIN"
USER_UPN="$PREFIX-user@$DOMAIN"

ADMIN_PASSWORD="$(mk_password)"
CREATOR_PASSWORD="$(mk_password)"
USER_PASSWORD="$(mk_password)"

ADMIN_ID="$(create_or_get_user_id "$ADMIN_UPN" "PHW Smoke Admin" "$ADMIN_PASSWORD")"
CREATOR_ID="$(create_or_get_user_id "$CREATOR_UPN" "PHW Smoke Event Creator" "$CREATOR_PASSWORD")"
USER_ID="$(create_or_get_user_id "$USER_UPN" "PHW Smoke User" "$USER_PASSWORD")"

assign_app_role_if_missing "$ADMIN_ID" "$ADMIN_ROLE_ID"
assign_app_role_if_missing "$CREATOR_ID" "$EVENT_CREATOR_ROLE_ID"
assign_app_role_if_missing "$USER_ID" "$USER_ROLE_ID"

echo
echo "Provisioned/verified RBAC test users:"
echo "ROLE,UPN,OBJECT_ID,INITIAL_PASSWORD"
echo "ADMIN,$ADMIN_UPN,$ADMIN_ID,$ADMIN_PASSWORD"
echo "EVENT_CREATOR,$CREATOR_UPN,$CREATOR_ID,$CREATOR_PASSWORD"
echo "USER,$USER_UPN,$USER_ID,$USER_PASSWORD"
echo
echo "If any user already existed, password may be unchanged in Entra unless reset separately."
