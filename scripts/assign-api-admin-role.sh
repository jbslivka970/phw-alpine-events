#!/usr/bin/env bash
set -euo pipefail

# Assign ADMIN app role on backend API app registration to a user.
#
# Usage:
#   ./scripts/assign-api-admin-role.sh \
#     --api-app-id 9a119fdd-b460-4b48-af69-a037234b8da3 \
#     --user-upn phw-test-admin@PHWAlpine.onmicrosoft.com \
#     --tenant-id d65d23ea-9a90-4080-b5ab-f427665cbfcf

API_APP_ID=""
USER_UPN=""
TENANT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-app-id)
      API_APP_ID="$2"
      shift 2
      ;;
    --user-upn)
      USER_UPN="$2"
      shift 2
      ;;
    --tenant-id)
      TENANT_ID="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$API_APP_ID" || -z "$USER_UPN" || -z "$TENANT_ID" ]]; then
  echo "Missing required args. Need --api-app-id, --user-upn, and --tenant-id" >&2
  exit 1
fi

if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI (az) is required. Run this in Azure Cloud Shell or where az is installed." >&2
  exit 1
fi

echo "Acquiring Graph token for tenant $TENANT_ID"
GRAPH_TOKEN="$(az account get-access-token --tenant "$TENANT_ID" --resource-type ms-graph --query accessToken -o tsv)"
if [[ -z "$GRAPH_TOKEN" ]]; then
  echo "Could not acquire Graph access token for tenant $TENANT_ID" >&2
  exit 1
fi

AUTH_HEADER="Authorization=Bearer $GRAPH_TOKEN"

echo "Resolving service principal for API app id: $API_APP_ID"
API_SP_ID="$(az rest \
  --method GET \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals?\$filter=appId eq '$API_APP_ID'" \
  --headers "$AUTH_HEADER" \
  --query "value[0].id" \
  -o tsv)"
if [[ -z "$API_SP_ID" ]]; then
  echo "Could not find service principal for app id $API_APP_ID" >&2
  exit 1
fi

echo "Resolving ADMIN app role id"
ADMIN_ROLE_ID="$(az rest \
  --method GET \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$API_SP_ID" \
  --headers "$AUTH_HEADER" \
  --query "appRoles[?value=='ADMIN' && contains(allowedMemberTypes, 'User')].id | [0]" \
  -o tsv)"
if [[ -z "$ADMIN_ROLE_ID" ]]; then
  echo "Could not find ADMIN app role on API service principal $API_SP_ID" >&2
  exit 1
fi

echo "Resolving user object id for: $USER_UPN"
USER_OBJECT_ID="$(az rest \
  --method GET \
  --uri "https://graph.microsoft.com/v1.0/users/$USER_UPN" \
  --headers "$AUTH_HEADER" \
  --query "id" \
  -o tsv)"
if [[ -z "$USER_OBJECT_ID" ]]; then
  echo "Could not find user $USER_UPN" >&2
  exit 1
fi

echo "Checking existing assignment"
EXISTING_ID="$(az rest \
  --method GET \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$API_SP_ID/appRoleAssignedTo" \
  --headers "$AUTH_HEADER" \
  --query "value[?principalId=='$USER_OBJECT_ID' && appRoleId=='$ADMIN_ROLE_ID'] | [0].id" \
  -o tsv)"

if [[ -n "$EXISTING_ID" ]]; then
  echo "ADMIN role already assigned. assignmentId=$EXISTING_ID"
  exit 0
fi

echo "Creating ADMIN assignment"
az rest \
  --method POST \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$API_SP_ID/appRoleAssignedTo" \
  --headers "$AUTH_HEADER" "Content-Type=application/json" \
  --body "{\"principalId\":\"$USER_OBJECT_ID\",\"resourceId\":\"$API_SP_ID\",\"appRoleId\":\"$ADMIN_ROLE_ID\"}" \
  --query "{assignmentId:id,principalId:principalId,resourceId:resourceId,appRoleId:appRoleId}" \
  -o json

echo "Done. Sign out/in in the app to get a fresh access token with ADMIN role claims."
