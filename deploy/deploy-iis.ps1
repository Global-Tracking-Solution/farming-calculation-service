# Deploys the Farming API on Windows + IIS. Run in PowerShell as Administrator:
#   Set-ExecutionPolicy Bypass -Scope Process -Force
#   .\deploy\deploy-iis.ps1
# Safe to re-run (also used for updates). Node runs as a Windows service (NSSM) on $NodePort;
# IIS listens on $PublicPort and forwards to it using deploy\web.config.

# ======================= SETTINGS =======================
$SourceDir   = Split-Path $PSScriptRoot -Parent   # this project folder
$AppDir      = "C:\apps\farming-api"             # where Node runs it from
$ProxyDir    = "C:\inetpub\farming-api"          # IIS site folder (only web.config)
$SiteName    = "FarmingAPI"
$ServiceName = "FarmingAPI"
$PublicPort  = 3000                              # IIS port (what clients call)
$NodePort    = 3001                              # internal Node port (keep closed in firewall)
$ApiKeys     = ""                                # comma-separated; empty = auto-generate one
$CorsOrigins = ""                                # e.g. https://your-website.com
$TimeZone    = "Asia/Kolkata"
# ========================================================

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$tmp = Join-Path $env:TEMP "farming-deploy"; New-Item -ItemType Directory -Force $tmp | Out-Null
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Download($url, $out) { if (-not (Test-Path $out)) { Invoke-WebRequest $url -OutFile $out -UseBasicParsing } }

Step "Installing IIS"
if (Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue) {
    Install-WindowsFeature Web-Server, Web-Mgmt-Console, Web-Http-Errors, Web-Filtering | Out-Null
} else {
    Enable-WindowsOptionalFeature -Online -All -NoRestart -FeatureName IIS-WebServerRole, IIS-WebServer, IIS-ManagementConsole, IIS-RequestFiltering | Out-Null
}
Import-Module WebAdministration

Step "Installing URL Rewrite and ARR"
$mods = (Get-WebGlobalModule).Name
if ($mods -notcontains "RewriteModule") {
    Download "https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi" "$tmp\rewrite.msi"
    Start-Process msiexec -ArgumentList "/i `"$tmp\rewrite.msi`" /qn /norestart" -Wait
}
if ($mods -notcontains "ApplicationRequestRouting") {
    Download "https://download.microsoft.com/download/E/9/8/E9849D6A-020E-47E4-9FD0-A023E99B54EB/requestRouter_amd64.msi" "$tmp\arr.msi"
    Start-Process msiexec -ArgumentList "/i `"$tmp\arr.msi`" /qn /norestart" -Wait
}
$mods = (Get-WebGlobalModule).Name
if ($mods -notcontains "RewriteModule" -or $mods -notcontains "ApplicationRequestRouting") {
    throw "URL Rewrite / ARR not installed. Install them from iis.net and re-run."
}

Step "Installing Node.js"
$nodeExe = "$env:ProgramFiles\nodejs\node.exe"
if (-not (Test-Path $nodeExe)) {
    Download "https://nodejs.org/dist/v22.11.0/node-v22.11.0-x64.msi" "$tmp\node.msi"
    Start-Process msiexec -ArgumentList "/i `"$tmp\node.msi`" /qn /norestart" -Wait
}
& $nodeExe -v

Step "Installing NSSM"
$nssm = "C:\tools\nssm\nssm.exe"
if (-not (Test-Path $nssm)) {
    Download "https://nssm.cc/release/nssm-2.24.zip" "$tmp\nssm.zip"
    Expand-Archive "$tmp\nssm.zip" "$tmp\nssm" -Force
    New-Item -ItemType Directory -Force (Split-Path $nssm) | Out-Null
    Copy-Item "$tmp\nssm\nssm-2.24\win64\nssm.exe" $nssm -Force
}

Step "Removing old service and site (if any)"
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    & $nssm stop $ServiceName | Out-Null
    & $nssm remove $ServiceName confirm | Out-Null
    Start-Sleep 2
}
if (Get-Website -Name $SiteName) { Remove-Website -Name $SiteName }
Get-Website | ForEach-Object {
    $s = $_.Name
    Get-WebBinding -Name $s | Where-Object { $_.bindingInformation -like "*:${PublicPort}:*" } | ForEach-Object {
        Write-Host "Removing port $PublicPort binding from site '$s'" -ForegroundColor Yellow
        Remove-WebBinding -Name $s -BindingInformation $_.bindingInformation -Protocol $_.protocol
    }
}

Step "Copying app to $AppDir"
New-Item -ItemType Directory -Force $AppDir, "$AppDir\logs" | Out-Null
robocopy $SourceDir $AppDir /MIR /XD node_modules .vscode test docs deploy logs /XF .env /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
Push-Location $AppDir
& "$env:ProgramFiles\nodejs\npm.cmd" ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
Pop-Location

Step "Creating Windows service $ServiceName (Node on port $NodePort)"
if (-not $ApiKeys) { $ApiKeys = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) }) }
& $nssm install $ServiceName $nodeExe "server.js" | Out-Null
& $nssm set $ServiceName AppDirectory $AppDir | Out-Null
& $nssm set $ServiceName AppEnvironmentExtra `
    "NODE_ENV=production" "PORT=$NodePort" "TZ=$TimeZone" "API_KEYS=$ApiKeys" `
    "CORS_ORIGINS=$CorsOrigins" "TRUST_PROXY=1" "SERVE_TEST_PAGE=false" `
    "MAX_CONCURRENT=2" "JOB_TIMEOUT_SECONDS=120" | Out-Null
& $nssm set $ServiceName AppStdout "$AppDir\logs\out.log" | Out-Null
& $nssm set $ServiceName AppStderr "$AppDir\logs\err.log" | Out-Null
& $nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $nssm set $ServiceName AppRotateBytes 10485760 | Out-Null
& $nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $nssm start $ServiceName | Out-Null

$ok = $false
foreach ($i in 1..15) {
    Start-Sleep 2
    try { $r = Invoke-WebRequest "http://127.0.0.1:$NodePort/health" -UseBasicParsing -TimeoutSec 3; $ok = $true; break } catch {}
}
if (-not $ok) {
    Get-Content "$AppDir\logs\err.log" -Tail 30 -ErrorAction SilentlyContinue
    throw "Node service failed on port $NodePort (see errors above)"
}
Write-Host "Node OK: $($r.Content)" -ForegroundColor Green

Step "Enabling ARR proxy"
& "$env:windir\system32\inetsrv\appcmd.exe" set config -section:system.webServer/proxy /enabled:"True" /preserveHostHeader:"True" /timeout:"00:03:00" /includePortInXForwardedFor:"False" /reverseRewriteHostInResponseHeaders:"False" /commit:apphost | Out-Null

Step "Creating IIS site $SiteName on port $PublicPort"
New-Item -ItemType Directory -Force $ProxyDir | Out-Null
(Get-Content "$SourceDir\deploy\web.config" -Raw) -replace '127\.0\.0\.1:\d+', "127.0.0.1:$NodePort" |
    Set-Content -Path "$ProxyDir\web.config" -Encoding UTF8
if (-not (Test-Path "IIS:\AppPools\$SiteName")) { New-WebAppPool -Name $SiteName | Out-Null }
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name managedRuntimeVersion -Value ""
New-Website -Name $SiteName -PhysicalPath $ProxyDir -ApplicationPool $SiteName -Port $PublicPort -IPAddress "*" | Out-Null
Start-Website -Name $SiteName

Step "Opening firewall port $PublicPort"
if (-not (Get-NetFirewallRule -DisplayName "FarmingAPI $PublicPort" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "FarmingAPI $PublicPort" -Direction Inbound -Protocol TCP -LocalPort $PublicPort -Action Allow | Out-Null
}

Step "Testing through IIS"
iisreset | Out-Null
Start-Sleep 3
$r = Invoke-WebRequest "http://localhost:$PublicPort/health" -UseBasicParsing
Write-Host "IIS OK: $($r.Content)" -ForegroundColor Green
Write-Host "`nDEPLOYED. Public URL: http://<server-ip>:$PublicPort/" -ForegroundColor Green
Write-Host "API key(s): $ApiKeys" -ForegroundColor Yellow
Write-Host "Logs: $AppDir\logs\err.log"
