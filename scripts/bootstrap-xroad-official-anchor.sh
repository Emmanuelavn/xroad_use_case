#!/usr/bin/env bash
set -euo pipefail

INSTANCE_IDENTIFIER="${INSTANCE_IDENTIFIER:-BJ}"
CENTRAL_SERVER_ADDRESS="${CENTRAL_SERVER_ADDRESS:-xroad-central}"
CENTRAL_SERVER_TOKEN_PIN="${CENTRAL_SERVER_TOKEN_PIN:-Str0ng-Pin!2026}"
ANCHOR_OUT="${ANCHOR_OUT:-xroad-official/configuration-anchor.xml}"

exec_text() {
  docker "$@"
}

wait_for_central_api() {
  local deadline=$((SECONDS + 240))
  while (( SECONDS < deadline )); do
    if docker exec xroad-central bash -lc \
      'curl -k -sS --max-time 5 https://127.0.0.1:4000/api/v1/initialization/status >/dev/null 2>&1'; then
      return 0
    fi
    sleep 5
  done
  echo "Central Server API did not become ready on https://127.0.0.1:4000 within 4 minutes" >&2
  return 1
}

central_curl() {
  local method="$1"
  local path="$2"
  local body="${3:-}"

  docker exec -e METHOD="$method" -e PATH_SUFFIX="$path" -e BODY="$body" xroad-central bash -lc '
    set -euo pipefail
    TOKEN=$(crudini --get /etc/xroad/conf.d/local.ini management-service api-token)
    if [ -n "$BODY" ]; then
      curl -k -sS --max-time 90 \
        -X "$METHOD" "https://127.0.0.1:4000/api/v1$PATH_SUFFIX" \
        -H "Authorization: X-Road-ApiKey token=$TOKEN" \
        -H "Content-Type: application/json" \
        -d "$BODY"
    else
      curl -k -sS --max-time 90 \
        -X "$METHOD" "https://127.0.0.1:4000/api/v1$PATH_SUFFIX" \
        -H "Authorization: X-Road-ApiKey token=$TOKEN"
    fi
  '
}

mkdir -p "$(dirname "$ANCHOR_OUT")"

echo "Granting lab API key admin roles..."
wait_for_central_api
docker exec xroad-central bash -lc '
  set -euo pipefail
  TOKEN=$(crudini --get /etc/xroad/conf.d/local.ini management-service api-token)
  ENCODED=$(echo -n "$TOKEN" | sha256sum -b | cut -d" " -f1)
  cat >/tmp/grant-api-key-roles.sql <<SQL
SET ROLE centerui;
INSERT INTO apikey_roles(apikey_id, role)
SELECT id, role
FROM apikey
CROSS JOIN (VALUES
  (\$\$XROAD_SECURITY_OFFICER\$\$),
  (\$\$XROAD_REGISTRATION_OFFICER\$\$),
  (\$\$XROAD_SYSTEM_ADMINISTRATOR\$\$),
  (\$\$XROAD_MANAGEMENT_SERVICE\$\$)
) AS roles(role)
WHERE encodedkey = \$\$${ENCODED}\$\$
ON CONFLICT DO NOTHING;
SQL
  su - postgres -c "psql -d centerui_production -f /tmp/grant-api-key-roles.sql"
'

echo "Initializing Central Server if needed..."
init_body=$(printf '{"software_token_pin":"%s","instance_identifier":"%s","central_server_address":"%s"}' \
  "$CENTRAL_SERVER_TOKEN_PIN" "$INSTANCE_IDENTIFIER" "$CENTRAL_SERVER_ADDRESS")
central_curl "POST" "/initialization" "$init_body"
echo

status=$(central_curl "GET" "/initialization/status")
echo "Initialization status: $status"

echo "Reading central token id..."
tokens_json=$(central_curl "GET" "/tokens")
token_id=$(printf '%s\n' "$tokens_json" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n 1)
if [ -z "$token_id" ]; then
  echo "No central token id found. Response: $tokens_json" >&2
  exit 1
fi

echo "Logging in central token..."
login_body=$(printf '{"password":"%s"}' "$CENTRAL_SERVER_TOKEN_PIN")
central_curl "PUT" "/tokens/$token_id/login" "$login_body"
echo

for configuration_source in INTERNAL EXTERNAL; do
  if printf '%s' "$tokens_json" | grep -Eq "\"active\":true[^}]*\"source_type\":\"$configuration_source\"|\"source_type\":\"$configuration_source\"[^}]*\"active\":true"; then
    echo "$configuration_source configuration signing key already active"
    continue
  fi

  echo "Creating $configuration_source configuration signing key..."
  key_body=$(printf '{"token_id":"%s","key_label":"%s-%s-CONFIG-SIGNING"}' \
    "$token_id" "$INSTANCE_IDENTIFIER" "$configuration_source")
  central_curl "POST" "/configuration-sources/$configuration_source/signing-keys" "$key_body"
  echo
done

echo "Re-creating and downloading internal configuration anchor..."
central_curl "PUT" "/configuration-sources/INTERNAL/anchor/re-create"
echo

docker exec xroad-central bash -lc '
  set -euo pipefail
  TOKEN=$(crudini --get /etc/xroad/conf.d/local.ini management-service api-token)
  curl -k -sS --max-time 90 \
    https://127.0.0.1:4000/api/v1/configuration-sources/INTERNAL/anchor/download \
    -H "Authorization: X-Road-ApiKey token=$TOKEN" \
    -o /tmp/configuration-anchor.xml
  test -s /tmp/configuration-anchor.xml
'
exec_text cp xroad-central:/tmp/configuration-anchor.xml "$ANCHOR_OUT"

security_servers=(
  "xroad_use_case-xroad-portal-ss-1"
  "xroad_use_case-xroad-anip-ss-1"
  "xroad_use_case-xroad-justice-ss-1"
  "xroad_use_case-xroad-dges-ss-1"
)

for container in "${security_servers[@]}"; do
  echo "Installing anchor into $container..."
  exec_text cp "$ANCHOR_OUT" "$container:/etc/xroad/configuration-anchor.xml"
done

echo "Restarting Security Servers..."
exec_text restart "${security_servers[@]}"

echo "Done. Anchor installed at $ANCHOR_OUT and copied to Security Servers."
