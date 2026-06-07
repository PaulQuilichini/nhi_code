# Ensures MSVC link.exe is available for Rust/Tauri on Windows.
# Installs "Build Tools for Visual Studio 2022" with the C++ workload if missing.

$ErrorActionPreference = "Stop"

function Find-LinkExe {
    $cmd = Get-Command link.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($installPath) {
            $msvcRoot = Join-Path $installPath "VC\Tools\MSVC"
            if (Test-Path $msvcRoot) {
                $link = Get-ChildItem -Path $msvcRoot -Recurse -Filter "link.exe" -ErrorAction SilentlyContinue |
                    Where-Object { $_.FullName -match "Hostx64\\x64\\link\.exe$" } |
                    Select-Object -First 1
                if ($link) { return $link.FullName }
            }
        }
    }

    return $null
}

$existing = Find-LinkExe
if ($existing) {
    Write-Host "  MSVC linker found: $existing" -ForegroundColor Green
    exit 0
}

Write-Host "  MSVC linker (link.exe) not found." -ForegroundColor Yellow
Write-Host "  Rust/Tauri requires Visual Studio Build Tools with C++." -ForegroundColor Yellow
Write-Host ""

$wingetPaths = @(
    "$env:LOCALAPPDATA\Microsoft\WindowsApps\winget.exe",
    "$env:ProgramFiles\WindowsApps\Microsoft.DesktopAppInstaller_*\winget.exe"
)

$winget = $null
foreach ($p in $wingetPaths) {
    $resolved = Resolve-Path $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($resolved) { $winget = $resolved.Path; break }
}

if (-not $winget) {
    Write-Host "  [ERROR] winget not available." -ForegroundColor Red
    Write-Host "  Install manually: https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Red
    Write-Host "  Select workload: 'Desktop development with C++'" -ForegroundColor Red
    exit 1
}

Write-Host "  Installing Visual Studio 2022 Build Tools (C++ workload)..." -ForegroundColor Cyan
Write-Host "  This may take several minutes and may prompt for administrator approval." -ForegroundColor Cyan
Write-Host ""

$override = "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
& $winget install -e --id Microsoft.VisualStudio.2022.BuildTools `
    --accept-package-agreements `
    --accept-source-agreements `
    --override $override

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  [ERROR] Build Tools install failed (exit $LASTEXITCODE)." -ForegroundColor Red
    Write-Host "  Install manually: https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Red
    exit 1
}

$existing = Find-LinkExe
if ($existing) {
    Write-Host ""
    Write-Host "  MSVC linker installed: $existing" -ForegroundColor Green
    Write-Host "  Restart this script if the next Rust build still fails." -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "  Build Tools installed, but link.exe not on PATH yet." -ForegroundColor Yellow
Write-Host "  Close this window, open a new terminal, and run start-nhicode.cmd again." -ForegroundColor Yellow
exit 0
