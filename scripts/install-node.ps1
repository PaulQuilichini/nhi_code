# Installs Node.js if missing. Used by start-nhicode.cmd
# 1. winget (system install, may prompt for admin)
# 2. Portable zip to %LOCALAPPDATA%\NHICode\nodejs (no admin)

$ErrorActionPreference = "Stop"

function Find-Node {
    $candidates = @(
        (Get-Command node -ErrorAction SilentlyContinue)?.Source,
        "$env:ProgramFiles\nodejs\node.exe",
        "$env:LocalAppData\Programs\nodejs\node.exe",
        "$env:LocalAppData\NHICode\nodejs\node.exe",
        "$env:LocalAppData\SuprModl\nodejs\node.exe",
        "$env:LocalAppData\SuperModel\nodejs\node.exe"
    ) | Where-Object { $_ -and (Test-Path $_) }

    if ($candidates.Count -gt 0) {
        return (Split-Path $candidates[0] -Parent)
    }
    return $null
}

$existing = Find-Node
if ($existing) {
    Write-Host "  Node.js already installed at $existing"
    Write-Output $existing
    exit 0
}

Write-Host "  Node.js not found — attempting install..."
Write-Host ""

# ── Try winget ───────────────────────────────────────────────────────────────
$wingetPaths = @(
    "$env:LocalAppData\Microsoft\WindowsApps\winget.exe",
    "$env:ProgramFiles\WindowsApps\Microsoft.DesktopAppInstaller_*\winget.exe"
)

$winget = $null
foreach ($p in $wingetPaths) {
    $resolved = Resolve-Path $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($resolved) { $winget = $resolved.Path; break }
}

if ($winget) {
    Write-Host "  Using winget to install Node.js LTS..."
    Write-Host "  (You may see a UAC prompt — click Yes to allow.)"
    Write-Host ""
    & $winget install -e --id OpenJS.NodeJS.LTS `
        --accept-package-agreements `
        --accept-source-agreements `
        --disable-interactivity

    Start-Sleep -Seconds 3
    $existing = Find-Node
    if ($existing) {
        Write-Host "  Node.js installed via winget."
        Write-Output $existing
        exit 0
    }
    Write-Host "  winget finished but node not on PATH yet — trying portable install..."
    Write-Host ""
}

# ── Portable zip (no admin) ──────────────────────────────────────────────────
$nodeVersion = "22.14.0"
$nodeDir = "$env:LOCALAPPDATA\NHICode\nodejs"
$nodeExe = Join-Path $nodeDir "node.exe"

if (-not (Test-Path $nodeExe)) {
    $zipUrl = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
    $tempZip = Join-Path $env:TEMP "nhicode-node.zip"
    $extractRoot = Join-Path $env:TEMP "nhicode-node-extract"

    Write-Host "  Downloading Node.js v$nodeVersion (portable)..."
    Write-Host "  $zipUrl"
    Write-Host ""

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $zipUrl -OutFile $tempZip -UseBasicParsing

    if (Test-Path $extractRoot) { Remove-Item $extractRoot -Recurse -Force }
    Expand-Archive -Path $tempZip -DestinationPath $extractRoot -Force

    $inner = Get-ChildItem $extractRoot -Directory | Select-Object -First 1
    if (-not $inner) { throw "Unexpected zip layout from nodejs.org" }

    if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
    New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
    Copy-Item -Path (Join-Path $inner.FullName "*") -Destination $nodeDir -Recurse -Force

    Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
    Remove-Item $extractRoot -Recurse -Force -ErrorAction SilentlyContinue

    Write-Host "  Installed portable Node.js to:"
    Write-Host "  $nodeDir"
}

if (Test-Path $nodeExe) {
    Write-Output $nodeDir
    exit 0
}

Write-Host "  [ERROR] Could not install Node.js automatically." -ForegroundColor Red
Write-Host "  Install manually from https://nodejs.org (LTS, v20+)" -ForegroundColor Red
exit 1
