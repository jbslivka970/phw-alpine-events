#!/usr/bin/env bash
set -euo pipefail

echo "This compatibility script is deprecated."
echo "Use ./scripts/configure-external-id-appsettings.sh instead."
echo
echo "For legacy B2C-style variable names, switch to the new script arguments:"
echo "  --b2c-tenant-name  => --tenant-name"
echo "  --policy-name      => --policy-name"
echo
exit 1
