param(
  [string]$InstanceIdentifier = "BJ",
  [string]$TokenPin = "Str0ng-Pin!2026",
  [string]$AnchorPath = "xroad-official/configuration-anchor.xml",
  [string]$StatePath = "xroad-official/bootstrap-state.json"
)

$ErrorActionPreference = "Stop"

$nodes = @(
  @{ Name = "portal";  Container = "xroad_use_case-xroad-portal-ss-1";  Hostname = "xroad-portal-ss";  OwnerCode = "PORTAL";  OwnerName = "Portail Concours"; ServerCode = "SS-PORTAL";  Subsystem = "CONCOURS"; SubsystemName = "Portail concours" },
  @{ Name = "anip";    Container = "xroad_use_case-xroad-anip-ss-1";    Hostname = "xroad-anip-ss";    OwnerCode = "ANIP";    OwnerName = "ANIP";             ServerCode = "SS-ANIP";    Subsystem = "REGISTRY";  SubsystemName = "Registre national" },
  @{ Name = "justice"; Container = "xroad_use_case-xroad-justice-ss-1"; Hostname = "xroad-justice-ss"; OwnerCode = "JUSTICE"; OwnerName = "Justice";          ServerCode = "SS-JUSTICE"; Subsystem = "CASIER";    SubsystemName = "Casier judiciaire" },
  @{ Name = "dges";    Container = "xroad_use_case-xroad-dges-ss-1";    Hostname = "xroad-dges-ss";    OwnerCode = "DGES";    OwnerName = "DGES";             ServerCode = "SS-DGES";    Subsystem = "DIPLOMES";  SubsystemName = "Diplomes" }
)

$providerServices = @(
  @{ Provider = "anip";    ServiceCode = "anip";    Url = "http://system-b-anip:3001";    Consumers = @("portal") },
  @{ Provider = "justice"; ServiceCode = "justice"; Url = "http://system-c-justice:3002"; Consumers = @("portal", "anip") },
  @{ Provider = "dges";    ServiceCode = "dges";    Url = "http://system-d-dges:3003";    Consumers = @("portal", "anip") }
)

function ExecText {
  param([string[]]$DockerArgs)
  $output = & docker @DockerArgs
  if ($LASTEXITCODE -ne 0) {
    throw "docker $($DockerArgs -join ' ') failed with exit code $LASTEXITCODE"
  }
  return ($output -join "`n")
}

function Read-State {
  if (Test-Path $StatePath) {
    return ConvertTo-Hashtable (Get-Content -Raw $StatePath | ConvertFrom-Json)
  }
  return @{ security_servers = @{} }
}

function ConvertTo-Hashtable {
  param([object]$InputObject)
  if ($null -eq $InputObject) { return $null }
  if ($InputObject -is [System.Collections.IDictionary]) {
    $hash = @{}
    foreach ($key in $InputObject.Keys) {
      $hash[$key] = ConvertTo-Hashtable $InputObject[$key]
    }
    return $hash
  }
  if ($InputObject -is [pscustomobject]) {
    $hash = @{}
    foreach ($property in $InputObject.PSObject.Properties) {
      $hash[$property.Name] = ConvertTo-Hashtable $property.Value
    }
    return $hash
  }
  if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
    return @($InputObject | ForEach-Object { ConvertTo-Hashtable $_ })
  }
  return $InputObject
}

function Save-State {
  param([hashtable]$State)
  New-Item -ItemType Directory -Force -Path (Split-Path $StatePath) | Out-Null
  $State | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 $StatePath
}

function Enc {
  param([string]$Value)
  return [System.Uri]::EscapeDataString($Value)
}

function Parse-CurlOutput {
  param(
    [string]$Raw,
    [int[]]$AllowedStatus,
    [string]$Context
  )
  $marker = "__HTTP_STATUS__"
  $idx = $Raw.LastIndexOf($marker)
  if ($idx -lt 0) {
    throw "$Context did not return an HTTP status marker. Output: $Raw"
  }
  $body = $Raw.Substring(0, $idx).Trim()
  $statusText = $Raw.Substring($idx + $marker.Length).Trim()
  $status = [int]$statusText
  if ($AllowedStatus -notcontains $status) {
    throw "$Context failed with HTTP $status. Body: $body"
  }
  return @{ Status = $status; Body = $body }
}

function Invoke-CentralApi {
  param(
    [string]$Method,
    [string]$Path,
    [object]$Body = $null,
    [int[]]$AllowedStatus = @(200, 201, 202, 204, 409)
  )
  $json = ""
  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Depth 20 -Compress
  }
  $script = @'
set -euo pipefail
TOKEN=$(crudini --get /etc/xroad/conf.d/local.ini management-service api-token)
tmp=$(mktemp)
args=(-k -sS --max-time 120 -o "$tmp" -w "%{http_code}" -X "$METHOD" "https://127.0.0.1:4000/api/v1$PATH_SUFFIX" -H "Authorization: X-Road-ApiKey token=$TOKEN")
if [ -n "${BODY:-}" ]; then
  args+=(-H "Content-Type: application/json" -d "$BODY")
fi
code=$(curl "${args[@]}" || true)
cat "$tmp" 2>/dev/null || true
printf "\n__HTTP_STATUS__%s\n" "$code"
'@
  $raw = ExecText -DockerArgs @("exec", "-e", "METHOD=$Method", "-e", "PATH_SUFFIX=$Path", "-e", "BODY=$json", "xroad-central", "bash", "-lc", $script)
  return Parse-CurlOutput -Raw $raw -AllowedStatus $AllowedStatus -Context "Central $Method $Path"
}

function Invoke-SsApi {
  param(
    [string]$Container,
    [string]$ApiKey,
    [string]$Method,
    [string]$Path,
    [object]$Body = $null,
    [int[]]$AllowedStatus = @(200, 201, 202, 204, 409)
  )
  $json = ""
  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Depth 20 -Compress
  }
  $script = @'
set -euo pipefail
tmp=$(mktemp)
args=(-k -sS --max-time 120 -o "$tmp" -w "%{http_code}" -X "$METHOD" "https://127.0.0.1:4000/api/v1$PATH_SUFFIX" -H "Authorization: X-Road-ApiKey token=$API_KEY")
if [ -n "${BODY:-}" ]; then
  args+=(-H "Content-Type: application/json" -d "$BODY")
fi
code=$(curl "${args[@]}" || true)
cat "$tmp" 2>/dev/null || true
printf "\n__HTTP_STATUS__%s\n" "$code"
'@
  $raw = ExecText -DockerArgs @("exec", "-e", "METHOD=$Method", "-e", "PATH_SUFFIX=$Path", "-e", "BODY=$json", "-e", "API_KEY=$ApiKey", $Container, "bash", "-lc", $script)
  return Parse-CurlOutput -Raw $raw -AllowedStatus $AllowedStatus -Context "$Container $Method $Path"
}

function Invoke-SsFormApi {
  param(
    [string]$Container,
    [string]$ApiKey,
    [string]$Method,
    [string]$Path,
    [string]$Field,
    [string]$ContainerFile,
    [int[]]$AllowedStatus = @(200, 201, 202, 204, 409)
  )
  $script = @'
set -euo pipefail
tmp=$(mktemp)
code=$(curl -k -sS --max-time 120 -o "$tmp" -w "%{http_code}" -X "$METHOD" "https://127.0.0.1:4000/api/v1$PATH_SUFFIX" \
  -H "Authorization: X-Road-ApiKey token=$API_KEY" \
  -F "$FIELD=@$FILE_PATH" || true)
cat "$tmp" 2>/dev/null || true
printf "\n__HTTP_STATUS__%s\n" "$code"
'@
  $raw = ExecText -DockerArgs @("exec", "-e", "METHOD=$Method", "-e", "PATH_SUFFIX=$Path", "-e", "API_KEY=$ApiKey", "-e", "FIELD=$Field", "-e", "FILE_PATH=$ContainerFile", $Container, "bash", "-lc", $script)
  return Parse-CurlOutput -Raw $raw -AllowedStatus $AllowedStatus -Context "$Container $Method $Path multipart"
}

function New-SsApiKey {
  param([string]$Container)
  $body = '["XROAD_SYSTEM_ADMINISTRATOR","XROAD_SECURITY_OFFICER","XROAD_SERVICE_ADMINISTRATOR","XROAD_REGISTRATION_OFFICER"]'
  $script = @'
set -euo pipefail
tmp=$(mktemp)
code=$(curl -k -sS --max-time 120 -o "$tmp" -w "%{http_code}" -u xrd:secret -X POST https://127.0.0.1:4000/api/v1/api-keys \
  -H "Content-Type: application/json" -d "$BODY" || true)
cat "$tmp" 2>/dev/null || true
printf "\n__HTTP_STATUS__%s\n" "$code"
'@
  $raw = ExecText -DockerArgs @("exec", "-e", "BODY=$body", $Container, "bash", "-lc", $script)
  $result = Parse-CurlOutput -Raw $raw -AllowedStatus @(200, 201) -Context "$Container create api key"
  return (($result.Body | ConvertFrom-Json).key)
}

function Wait-SsApi {
  param([string]$Container)
  $deadline = (Get-Date).AddMinutes(5)
  while ((Get-Date) -lt $deadline) {
    $probe = ExecText -DockerArgs @("exec", $Container, "bash", "-lc", "curl -k -sS --max-time 5 https://127.0.0.1:4000/api/v1/initialization/status >/dev/null 2>&1; echo `$?")
    if ($probe.Trim() -eq "0") { return }
    Start-Sleep -Seconds 5
  }
  throw "$Container Security Server API did not become ready"
}

function MemberId {
  param([hashtable]$Node)
  return "$InstanceIdentifier`:GOV`:$($Node.OwnerCode)"
}

function SubsystemId {
  param([hashtable]$Node)
  return "$InstanceIdentifier`:GOV`:$($Node.OwnerCode)`:$($Node.Subsystem)"
}

function ServerId {
  param([hashtable]$Node)
  return "$InstanceIdentifier`:GOV`:$($Node.OwnerCode)`:$($Node.ServerCode)"
}

function Approve-PendingRequests {
  Write-Host "Approving Central Server management requests..."
  $response = Invoke-CentralApi -Method "GET" -Path "/management-requests" -AllowedStatus @(200)
  if (-not $response.Body) { return }
  $requests = ($response.Body | ConvertFrom-Json).items
  foreach ($request in @($requests)) {
    if ($request.status -eq "APPROVED" -or $request.status -eq "DECLINED" -or $request.status -eq "REVOKED") {
      continue
    }
    Write-Host "Approving request #$($request.id) $($request.type) for $($request.security_server_id.member_code)/$($request.security_server_id.server_code)..."
    Invoke-CentralApi -Method "POST" -Path "/management-requests/$($request.id)/approval" -AllowedStatus @(200, 204, 409) | Out-Null
  }
}

function Ensure-CentralTopology {
  Write-Host "Creating Central Server member class, members and subsystems..."
  Invoke-CentralApi -Method "POST" -Path "/member-classes" -Body @{ code = "GOV"; description = "Government services" } | Out-Null

  foreach ($node in $nodes) {
    Invoke-CentralApi -Method "POST" -Path "/members" -Body @{
      member_name = $node.OwnerName
      member_id = @{ member_class = "GOV"; member_code = $node.OwnerCode }
    } | Out-Null

    Invoke-CentralApi -Method "POST" -Path "/subsystems" -Body @{
      subsystem_name = $node.SubsystemName
      subsystem_id = @{ member_class = "GOV"; member_code = $node.OwnerCode; subsystem_code = $node.Subsystem }
    } | Out-Null
  }
}

function Ensure-SecurityServer {
  param(
    [hashtable]$Node,
    [hashtable]$State
  )

  Write-Host "Configuring Security Server $($Node.Name)..."
  Wait-SsApi -Container $Node.Container

  if (-not $State.security_servers.ContainsKey($Node.Name)) {
    $State.security_servers[$Node.Name] = @{}
  }
  if (-not $State.security_servers[$Node.Name].api_key) {
    $State.security_servers[$Node.Name].api_key = New-SsApiKey -Container $Node.Container
    Save-State -State $State
  }
  $apiKey = $State.security_servers[$Node.Name].api_key

  ExecText -DockerArgs @("cp", $AnchorPath, "$($Node.Container):/tmp/configuration-anchor.xml") | Out-Null
  Invoke-SsFormApi -Container $Node.Container -ApiKey $apiKey -Method "POST" -Path "/system/anchor" -Field "anchor" -ContainerFile "/tmp/configuration-anchor.xml" | Out-Null

  Invoke-SsApi -Container $Node.Container -ApiKey $apiKey -Method "POST" -Path "/initialization" -Body @{
    owner_member_class = "GOV"
    owner_member_code = $Node.OwnerCode
    security_server_code = $Node.ServerCode
    software_token_pin = $TokenPin
    ignore_warnings = $true
  } | Out-Null

  $tokensJson = Invoke-SsApi -Container $Node.Container -ApiKey $apiKey -Method "GET" -Path "/tokens" -AllowedStatus @(200)
  $token = @($tokensJson.Body | ConvertFrom-Json)[0]
  if (-not $token.id) { throw "No software token found in $($Node.Container)" }
  Invoke-SsApi -Container $Node.Container -ApiKey $apiKey -Method "PUT" -Path "/tokens/$($token.id)/login" -Body @{ password = $TokenPin } -AllowedStatus @(200) | Out-Null

  if (-not $State.security_servers[$Node.Name].sign_cert_hash) {
    $State.security_servers[$Node.Name].sign_cert_hash = New-And-ImportCertificate -Node $Node -ApiKey $apiKey -TokenId $token.id -Usage "SIGNING"
    Save-State -State $State
  }

  if (-not $State.security_servers[$Node.Name].auth_cert_hash) {
    $State.security_servers[$Node.Name].auth_cert_hash = New-And-ImportCertificate -Node $Node -ApiKey $apiKey -TokenId $token.id -Usage "AUTHENTICATION"
    Save-State -State $State
  }

  Invoke-SsApi -Container $Node.Container -ApiKey $apiKey -Method "PUT" -Path "/token-certificates/$($State.security_servers[$Node.Name].auth_cert_hash)/register" -Body @{ address = $Node.Hostname } -AllowedStatus @(200, 204, 409) | Out-Null
  Approve-PendingRequests
  Invoke-SsApi -Container $Node.Container -ApiKey $apiKey -Method "PUT" -Path "/token-certificates/$($State.security_servers[$Node.Name].auth_cert_hash)/activate" -AllowedStatus @(200, 204, 409) | Out-Null
  Invoke-SsApi -Container $Node.Container -ApiKey $apiKey -Method "PUT" -Path "/token-certificates/$($State.security_servers[$Node.Name].sign_cert_hash)/activate" -AllowedStatus @(200, 204, 409) | Out-Null

  $subsystemId = SubsystemId -Node $Node
  Invoke-SsApi -Container $Node.Container -ApiKey $apiKey -Method "POST" -Path "/clients" -Body @{
    client = @{ member_class = "GOV"; member_code = $Node.OwnerCode; subsystem_code = $Node.Subsystem }
    ignore_warnings = $true
  } | Out-Null

  Invoke-SsApi -Container $Node.Container -ApiKey $apiKey -Method "PUT" -Path "/clients/$(Enc $subsystemId)/register" -AllowedStatus @(200, 204, 409) | Out-Null
  Approve-PendingRequests
}

function New-And-ImportCertificate {
  param(
    [hashtable]$Node,
    [string]$ApiKey,
    [string]$TokenId,
    [string]$Usage
  )

  $memberId = MemberId -Node $Node
  $label = "$($Node.Name)-$($Usage.ToLowerInvariant())"
  $subject = @{ C = "BJ"; O = $Node.OwnerCode; CN = "$($Node.OwnerCode)-$Usage" }
  $csrGenerate = @{
    key_usage_type = $Usage
    ca_name = "Test CA"
    csr_format = "PEM"
    subject_field_values = $subject
  }
  if ($Usage -eq "SIGNING") {
    $csrGenerate.member_id = $memberId
  }

  Write-Host "Creating $Usage key and CSR for $($Node.Name)..."
  $created = Invoke-SsApi -Container $Node.Container -ApiKey $ApiKey -Method "POST" -Path "/tokens/$(Enc $TokenId)/keys-with-csrs" -Body @{
    key_label = $label
    csr_generate_request = $csrGenerate
  } -AllowedStatus @(201)
  $createdBody = $created.Body | ConvertFrom-Json
  $keyId = $createdBody.key.id
  $csrId = $createdBody.csr_id
  $csrPath = "/tmp/$($Node.Name)-$Usage.csr"
  $certPath = "/tmp/$($Node.Name)-$Usage.cer"

  $download = @'
set -euo pipefail
curl -k -sS --fail --max-time 120 "https://127.0.0.1:4000/api/v1/keys/$KEY_ID/csrs/$CSR_ID?csr_format=PEM" \
  -H "Authorization: X-Road-ApiKey token=$API_KEY" -o "$CSR_PATH"
test -s "$CSR_PATH"
'@
  ExecText -DockerArgs @("exec", "-e", "KEY_ID=$keyId", "-e", "CSR_ID=$csrId", "-e", "API_KEY=$ApiKey", "-e", "CSR_PATH=$csrPath", $Node.Container, "bash", "-lc", $download) | Out-Null

  $sign = @'
set -euo pipefail
curl -sS --fail --max-time 120 -F "certreq=@$CSR_PATH" http://xroad-central:8888/testca/sign -o "$CERT_PATH"
test -s "$CERT_PATH"
'@
  ExecText -DockerArgs @("exec", "-e", "CSR_PATH=$csrPath", "-e", "CERT_PATH=$certPath", $Node.Container, "bash", "-lc", $sign) | Out-Null

  $imported = Invoke-SsFormApi -Container $Node.Container -ApiKey $ApiKey -Method "POST" -Path "/token-certificates" -Field "certificate" -ContainerFile $certPath -AllowedStatus @(201, 409)
  if ($imported.Status -eq 409) {
    throw "Certificate import conflict for $($Node.Name) $Usage. Remove $StatePath if you intentionally reset containers."
  }
  $cert = $imported.Body | ConvertFrom-Json
  $hash = $cert.certificate_details.hash
  if (-not $hash) { throw "Could not read imported certificate hash for $($Node.Name) $Usage. Body: $($imported.Body)" }
  return $hash
}

function Ensure-ProviderService {
  param(
    [hashtable]$Service,
    [hashtable]$State
  )
  $provider = @($nodes | Where-Object { $_.Name -eq $Service.Provider })[0]
  $apiKey = $State.security_servers[$provider.Name].api_key
  $providerClientId = SubsystemId -Node $provider

  Write-Host "Publishing REST service $($Service.ServiceCode) on $($provider.Name)..."
  $created = Invoke-SsApi -Container $provider.Container -ApiKey $apiKey -Method "POST" -Path "/clients/$(Enc $providerClientId)/service-descriptions" -Body @{
    url = $Service.Url
    rest_service_code = $Service.ServiceCode
    type = "REST"
    ignore_warnings = $true
  } -AllowedStatus @(201, 409)

  $descriptionId = $null
  if ($created.Status -eq 201 -and $created.Body) {
    $descriptionId = ($created.Body | ConvertFrom-Json).id
  } else {
    $descriptions = Invoke-SsApi -Container $provider.Container -ApiKey $apiKey -Method "GET" -Path "/clients/$(Enc $providerClientId)/service-descriptions" -AllowedStatus @(200)
    $descriptionId = @($descriptions.Body | ConvertFrom-Json | Where-Object { $_.url -eq $Service.Url -or $_.rest_service_code -eq $Service.ServiceCode } | Select-Object -First 1).id
  }

  if ($descriptionId) {
    Invoke-SsApi -Container $provider.Container -ApiKey $apiKey -Method "PUT" -Path "/service-descriptions/$(Enc $descriptionId)/enable" -AllowedStatus @(200, 204, 409) | Out-Null
  }

  foreach ($consumerName in $Service.Consumers) {
    $consumer = @($nodes | Where-Object { $_.Name -eq $consumerName })[0]
    $consumerId = SubsystemId -Node $consumer
    Write-Host "Granting $consumerId access to $($Service.ServiceCode)..."
    Invoke-SsApi -Container $provider.Container -ApiKey $apiKey -Method "POST" -Path "/clients/$(Enc $providerClientId)/service-clients/$(Enc $consumerId)/access-rights" -Body @{
      items = @(@{ service_code = $Service.ServiceCode })
    } -AllowedStatus @(200, 201, 204, 409) | Out-Null
  }
}

Write-Host "Starting official X-Road stack..."
ExecText -DockerArgs @("compose", "-f", "docker-compose.xroad-official.yml", "up", "-d", "--build") | Write-Host

Write-Host "Bootstrapping Central Server anchor and signing keys..."
& "$PSScriptRoot\bootstrap-xroad-official-anchor.ps1" -InstanceIdentifier $InstanceIdentifier -CentralServerTokenPin $TokenPin -AnchorOut $AnchorPath

$state = Read-State
Ensure-CentralTopology
foreach ($node in $nodes) {
  Ensure-SecurityServer -Node $node -State $state
}
Approve-PendingRequests
foreach ($service in $providerServices) {
  Ensure-ProviderService -Service $service -State $state
}

Write-Host "Refreshing internal configuration anchor after registrations..."
Invoke-CentralApi -Method "PUT" -Path "/configuration-sources/INTERNAL/anchor/re-create" -AllowedStatus @(200) | Out-Null

Write-Host "Full X-Road setup requested. Wait 1-2 minutes for global configuration propagation, then test:"
Write-Host "  curl http://localhost:8180/r1/BJ/GOV/ANIP/REGISTRY/anip/api/v1/anip/personnes/10000000000001 -H 'X-Road-Client: BJ/GOV/PORTAL/CONCOURS'"
Write-Host "  Open https://localhost:3000 for the portal."
