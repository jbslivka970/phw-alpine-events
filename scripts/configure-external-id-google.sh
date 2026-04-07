#!/usr/bin/env bash
set -euo pipefail

# Configure Google as a social identity provider in Microsoft Entra External ID.
# Optionally attach it to a b2cUserFlow when --user-flow-id is provided.
#
# Prereqs:
# - Azure CLI logged in with access to the External ID tenant.
# - AZURE_CLI_DISABLE_CONNECTION_VERIFICATION=1 may be required in this environment.
#
# Usage:
#   ./scripts/configure-external-id-google.sh \
#     --tenant-id d65d23ea-9a90-4080-b5ab-f427665cbfcf \
#     --google-client-id <GOOGLE_CLIENT_ID> \
#     --google-client-secret <GOOGLE_CLIENT_SECRET> \
#     --provisioning-client-id <ENTRA_PROVISIONING_CLIENT_ID> \
#     --provisioning-client-secret <ENTRA_PROVISIONING_CLIENT_SECRET> \
#     --user-flow-id B2C_1_signupsignin \
#     --create-user-flow-if-missing

TENANT_ID=""
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
USER_FLOW_ID=""
DISPLAY_NAME="Google"
PROVISIONING_CLIENT_ID=""
PROVISIONING_CLIENT_SECRET=""
CREATE_USER_FLOW_IF_MISSING="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant-id)
      TENANT_ID="$2"
      shift 2
      ;;
    --google-client-id)
      GOOGLE_CLIENT_ID="$2"
      shift 2
      ;;
    --google-client-secret)
      GOOGLE_CLIENT_SECRET="$2"
      shift 2
      ;;
    --user-flow-id)
      USER_FLOW_ID="$2"
      shift 2
      ;;
    --provisioning-client-id)
      PROVISIONING_CLIENT_ID="$2"
      shift 2
      ;;
    --provisioning-client-secret)
      PROVISIONING_CLIENT_SECRET="$2"
      shift 2
      ;;
    --create-user-flow-if-missing)
      CREATE_USER_FLOW_IF_MISSING="true"
      shift 1
      ;;
    --display-name)
      DISPLAY_NAME="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

for required in TENANT_ID GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  if [[ -z "${!required}" ]]; then
    echo "Missing required value: ${required}" >&2
    exit 1
  fi
done

GRAPH_TOKEN=""

if [[ -n "${PROVISIONING_CLIENT_ID}" && -n "${PROVISIONING_CLIENT_SECRET}" ]]; then
  GRAPH_TOKEN=$(curl -sS -X POST \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "client_id=${PROVISIONING_CLIENT_ID}" \
    --data-urlencode "client_secret=${PROVISIONING_CLIENT_SECRET}" \
    --data-urlencode "scope=https://graph.microsoft.com/.default" \
    --data-urlencode "grant_type=client_credentials" \
    "https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token" \
    | python3 -c "
import json, sys
doc = json.load(sys.stdin)
if 'access_token' in doc:
    print(doc['access_token'])
else:
    print('ERROR:' + doc.get('error_description', doc.get('error', 'token_error')))
")

  if [[ "${GRAPH_TOKEN}" == ERROR:* ]]; then
    echo "Failed to acquire app-only Graph token: ${GRAPH_TOKEN}" >&2
    exit 1
  fi
else
  GRAPH_TOKEN=$(AZURE_CLI_DISABLE_CONNECTION_VERIFICATION=${AZURE_CLI_DISABLE_CONNECTION_VERIFICATION:-1} \
    az account get-access-token \
    --tenant "${TENANT_ID}" \
    --resource-type ms-graph \
    --query accessToken -o tsv)
fi

if [[ -z "${GRAPH_TOKEN}" ]]; then
  echo "Failed to obtain Microsoft Graph token for tenant ${TENANT_ID}." >&2
  exit 1
fi

echo "Checking for existing Google identity provider..."
PROVIDERS_JSON=$(curl -sS -H "Authorization: Bearer ${GRAPH_TOKEN}" \
  "https://graph.microsoft.com/v1.0/identity/identityProviders")

GOOGLE_PROVIDER_ID=$(echo "${PROVIDERS_JSON}" | python3 -c "
import json, sys
doc = json.load(sys.stdin)
for item in doc.get('value', []):
    t = (item.get('identityProviderType') or '').lower()
    if t == 'google':
        print(item.get('id', ''))
        break
")

if [[ -n "${GOOGLE_PROVIDER_ID}" ]]; then
  echo "Found existing Google provider: ${GOOGLE_PROVIDER_ID}. Updating credentials..."
  curl -sS -X PATCH \
    -H "Authorization: Bearer ${GRAPH_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"displayName\":\"${DISPLAY_NAME}\",\"clientId\":\"${GOOGLE_CLIENT_ID}\",\"clientSecret\":\"${GOOGLE_CLIENT_SECRET}\"}" \
    "https://graph.microsoft.com/v1.0/identity/identityProviders/${GOOGLE_PROVIDER_ID}" >/dev/null
else
  echo "Creating Google identity provider..."
  CREATE_RESP=$(curl -sS -X POST \
    -H "Authorization: Bearer ${GRAPH_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"@odata.type\":\"#microsoft.graph.socialIdentityProvider\",\"displayName\":\"${DISPLAY_NAME}\",\"identityProviderType\":\"Google\",\"clientId\":\"${GOOGLE_CLIENT_ID}\",\"clientSecret\":\"${GOOGLE_CLIENT_SECRET}\"}" \
    "https://graph.microsoft.com/v1.0/identity/identityProviders")

  GOOGLE_PROVIDER_ID=$(echo "${CREATE_RESP}" | python3 -c "
import json, sys
doc = json.load(sys.stdin)
if 'error' in doc:
    print('ERROR:' + doc['error'].get('message', 'Unknown Graph error'))
else:
    print(doc.get('id', ''))
")

  if [[ "${GOOGLE_PROVIDER_ID}" == ERROR:* || -z "${GOOGLE_PROVIDER_ID}" ]]; then
    echo "Failed to create Google provider: ${GOOGLE_PROVIDER_ID}" >&2
    exit 1
  fi
fi

echo "Google provider ready: ${GOOGLE_PROVIDER_ID}"

if [[ -z "${USER_FLOW_ID}" ]]; then
  echo "No --user-flow-id supplied. Skipping user flow attach."
  echo "Available user flows in tenant:"
  curl -sS -H "Authorization: Bearer ${GRAPH_TOKEN}" \
    "https://graph.microsoft.com/v1.0/identity/b2cUserFlows" \
    | python3 -c "
import json, sys
doc = json.load(sys.stdin)
flows = doc.get('value', [])
if not flows:
    print('  (none found)')
for flow in flows:
    print('  ' + flow.get('id', ''))
"
  exit 0
fi

FLOW_EXISTS=$(curl -sS -H "Authorization: Bearer ${GRAPH_TOKEN}" \
  "https://graph.microsoft.com/v1.0/identity/b2cUserFlows/${USER_FLOW_ID}" \
  | python3 -c "
import json, sys
doc = json.load(sys.stdin)
print('false' if 'error' in doc else 'true')
")

if [[ "${FLOW_EXISTS}" != "true" ]]; then
  if [[ "${CREATE_USER_FLOW_IF_MISSING}" != "true" ]]; then
    echo "User flow ${USER_FLOW_ID} not found. Re-run with --create-user-flow-if-missing to create it." >&2
    exit 1
  fi

  echo "Creating user flow ${USER_FLOW_ID}..."
  CREATE_FLOW_RESP=$(curl -sS -X POST \
    -H "Authorization: Bearer ${GRAPH_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"id\":\"${USER_FLOW_ID}\",\"userFlowType\":\"signUpOrSignIn\",\"userFlowTypeVersion\":1}" \
    "https://graph.microsoft.com/v1.0/identity/b2cUserFlows")

  CREATE_FLOW_ERR=$(echo "${CREATE_FLOW_RESP}" | python3 -c "
import json, sys
doc = json.load(sys.stdin)
print(doc.get('error', {}).get('message', ''))
")

  if [[ -n "${CREATE_FLOW_ERR}" ]]; then
    echo "Failed to create user flow ${USER_FLOW_ID}: ${CREATE_FLOW_ERR}" >&2
    exit 1
  fi
fi

echo "Attaching provider to user flow ${USER_FLOW_ID} (idempotent)..."
set +e
ATTACH_RESP=$(curl -sS -X POST \
  -H "Authorization: Bearer ${GRAPH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"@odata.id\":\"https://graph.microsoft.com/v1.0/identity/identityProviders/${GOOGLE_PROVIDER_ID}\"}" \
  "https://graph.microsoft.com/v1.0/identity/b2cUserFlows/${USER_FLOW_ID}/identityProviders/\$ref")
ATTACH_EXIT=$?
set -e

if [[ ${ATTACH_EXIT} -ne 0 ]]; then
  echo "Failed to attach provider to flow ${USER_FLOW_ID}." >&2
  exit 1
fi

if [[ -n "${ATTACH_RESP}" ]]; then
  echo "Attach response: ${ATTACH_RESP}"
else
  echo "Google provider attached to user flow ${USER_FLOW_ID}."
fi

echo "Done."
