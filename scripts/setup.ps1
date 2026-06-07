# Install script for Windows
# Requires Node.js 20+ and pnpm: npm install -g pnpm

Write-Host "NHI Code Setup" -ForegroundColor Cyan
Write-Host "==============" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js not found. Install from https://nodejs.org (v20+)" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "Installing pnpm..." -ForegroundColor Yellow
    npm install -g pnpm
}

Write-Host "Installing dependencies..." -ForegroundColor Green
pnpm install

Write-Host "Building packages..." -ForegroundColor Green
pnpm build

Write-Host ""
Write-Host "Setup complete! Run:" -ForegroundColor Green
Write-Host "  pnpm dev" -ForegroundColor White
Write-Host ""
Write-Host "Then open http://localhost:5173" -ForegroundColor Gray
