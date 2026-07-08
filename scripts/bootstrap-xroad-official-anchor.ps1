param(
  [string]$InstanceIdentifier = "BJ",
  [string]$CentralServerAddress = "xroad-central",
  [string]$CentralServerTokenPin = "Str0ng-Pin!2026",
  [string]$AnchorOut = "xroad-official/configuration-anchor.xml"
)

$ErrorActionPreference = "Stop"

function ExecText {
  param([string[]]$Args)
  $output = & docker @Args
  if ($LASTEXITCODE -ne 0) {
    throw "docker $($Args -join ' ') failed with exit code $LASTEXITCODE"
  }
  return ($output -join "`n")
}

function CentralCurl {
  param(
    [string]$Method,
    [string]$Path,
    [string]$Body = ""
  )
  $bodyArg = ""
  if ($Body) {
    $escaped = $Body.Replace("'", "'\''")
    $bodyArg = "-H 'Content-Type: application/json' -d '$escaped'"
  }

  $cmd = @"
TOKEN=`$(crudini --get /etc/xroad/conf.d/local.ini management-service api-token)
curl -k -sS --max-time 90 -X $Method https://127.0.0.1:4000/api/v1$Path -H "Authorization: X-Road-ApiKey token=`$TOKEN" $bodyArg
"@
  ExecText @("exec", "xroad-central", "bash", "-lc", $cmd)
}

New-Item -ItemType Directory -Force -Path (Split-Path $AnchorOut) | Out-Null

Write-Host "Granting lab API key admin roles..."
$grantRoles = @'
TOKEN=$(crudini --get /etc/xroad/conf.d/local.ini management-service api-token)
ENCODED=$(echo -n "$TOKEN" | sha256sum -b | cut -d" " -f1)
cat >/tmp/grant-api-key-roles.sql <<SQL
SET ROLE centerui;
INSERT INTO apikey_roles(apikey_id, role)
SELECT id, role
FROM apikey
CROSS JOIN (VALUES
  ('XROAD_SECURITY_OFFICER'),
  ('XROAD_REGISTRATION_OFFICER'),
  ('XROAD_SYSTEM_ADMINISTRATOR'),
  ('XROAD_MANAGEMENT_SERVICE')
) AS roles(role)
WHERE encodedkey = '$ENCODED'
ON CONFLICT DO NOTHING;
SQL
su - postgres -c "psql -d centerui_production -f /tmp/grant-api-key-roles.sql"
'@
ExecText @("exec", "xroad-central", "bash", "-lc", $grantRoles) | Write-Host

Write-Host "Initializing Central Server if needed..."
$initBody = @{
  software_token_pin = $CentralServerTokenPin
  instance_identifier = $InstanceIdentifier
  central_server_address = $CentralServerAddress
} | ConvertTo-Json -Compress
$initResponse = CentralCurl "POST" "/initialization" $initBody
Write-Host $initResponse

$status = CentralCurl "GET" "/initialization/status"
Write-Host "Initialization status: $status"

Write-Host "Reading central token id..."
$tokensJson = CentralCurl "GET" "/tokens"
$tokens = $tokensJson | ConvertFrom-Json
if (-not $tokens -or -not $tokens[0].id) {
  throw "No central token id found. Response: $tokensJson"
}
$tokenId = $tokens[0].id

Write-Host "Logging in central token..."
$loginBody = @{ password = $CentralServerTokenPin } | ConvertTo-Json -Compress
CentralCurl "PUT" "/tokens/$tokenId/login" $loginBody | Write-Host

Write-Host "Creating configuration signing key if needed..."
$keyBody = @{
  token_id = $tokenId
  key_label = "BJ-INTERNAL-CONFIG-SIGNING"
} | ConvertTo-Json -Compress
CentralCurl "POST" "/configuration-sources/INTERNAL/signing-keys" $keyBody | Write-Host

Write-Host "Re-creating and downloading internal configuration anchor..."
CentralCurl "PUT" "/configuration-sources/INTERNAL/anchor/re-create" | Write-Host

$downloadCmd = @"
TOKEN=`$(crudini --get /etc/xroad/conf.d/local.ini management-service api-token)
curl -k -sS --max-time 90 https://127.0.0.1:4000/api/v1/configuration-sources/INTERNAL/anchor/download -H "Authorization: X-Road-ApiKey token=`$TOKEN" -o /tmp/configuration-anchor.xml
test -s /tmp/configuration-anchor.xml
"@
ExecText @("exec", "xroad-central", "bash", "-lc", $downloadCmd) | Out-Null
ExecText @("cp", "xroad-central:/tmp/configuration-anchor.xml", $AnchorOut) | Out-Null

$securityServers = @(
  "xroad_use_case-xroad-portal-ss-1",
  "xroad_use_case-xroad-anip-ss-1",
  "xroad_use_case-xroad-justice-ss-1",
  "xroad_use_case-xroad-dges-ss-1"
)

foreach ($container in $securityServers) {
  Write-Host "Installing anchor into $container..."
  ExecText @("cp", $AnchorOut, "${container}:/etc/xroad/configuration-anchor.xml") | Out-Null
}

Write-Host "Restarting Security Servers..."
ExecText @("restart", $securityServers[0], $securityServers[1], $securityServers[2], $securityServers[3]) | Write-Host

Write-Host "Done. Anchor installed at $AnchorOut and copied to Security Servers."
