@echo off
setlocal EnableDelayedExpansion

REM NHI Code launcher — double-click to install deps (if needed) and start the app.

cd /d "%~dp0"
title NHI Code

echo.
echo  NHI Code
echo  ========
echo  Non-Human Intelligence coding agent
echo.

call :FindNode
if defined NODE_DIR goto :NodeReady

echo  Node.js is not installed.
echo.
echo  NHI Code can install it automatically ^(winget or portable, no admin needed^).
echo.
set /p INSTALL_NODE="  Install Node.js now? [Y/n] "
if /i "!INSTALL_NODE!"=="n" goto :NodeManual

echo.
for /f "delims=" %%d in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-node.ps1"') do set "NODE_DIR=%%d"
if not defined NODE_DIR (
  echo.
  echo  [ERROR] Automatic Node.js install failed.
  goto :NodeManual
)
set "PATH=!NODE_DIR!;!PATH!"
goto :NodeReady

:NodeManual
echo.
echo  Install Node.js 20+ from https://nodejs.org then run this script again.
echo.
pause
exit /b 1

:NodeReady
set "PATH=!NODE_DIR!;!PATH!"

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo  [ERROR] Node.js still not available after install.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
echo  Node.js !NODE_VER!

for /f "delims=" %%m in ('node -p "Number(process.version.slice(1).split('.')[0])" 2^>nul') do set NODE_MAJOR=%%m
if !NODE_MAJOR! LSS 20 (
  echo  [WARNING] Node.js 20+ is recommended. You have v!NODE_MAJOR!.
  echo.
)

where pnpm >nul 2>&1
if %ERRORLEVEL% neq 0 (
  call corepack enable >nul 2>&1
)
where pnpm >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo  pnpm not found - installing globally...
  call npm install -g pnpm
  if !ERRORLEVEL! neq 0 (
    echo  [ERROR] Could not install pnpm.
    pause
    exit /b 1
  )
)

for /f "delims=" %%v in ('pnpm -v 2^>nul') do set PNPM_VER=%%v
echo  pnpm !PNPM_VER!
echo.

call :InstallDeps
if !ERRORLEVEL! neq 0 (
  echo  [ERROR] pnpm install failed.
  pause
  exit /b 1
)
echo.

where cargo >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo  [WARNING] Rust not found. NHI Code needs Rust for the native app.
  echo  Install from https://rustup.rs
  echo.
  set /p CONTINUE="  Continue anyway? [y/N] "
  if /i not "!CONTINUE!"=="y" exit /b 1
)

call "%~dp0scripts\check-msvc.cmd"
if !ERRORLEVEL! neq 0 (
  echo  MSVC C++ Build Tools not found ^(link.exe missing^).
  echo  Rust needs this to compile the native NHI Code shell.
  echo.
  set /p INSTALL_MSVC="  Install Build Tools now? [Y/n] "
  if /i "!INSTALL_MSVC!"=="n" goto :MsvcManual
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-msvc.ps1"
  call "%~dp0scripts\setup-msvc-env.cmd"
  call "%~dp0scripts\check-msvc.cmd"
  if !ERRORLEVEL! neq 0 (
    echo.
    echo  [ERROR] MSVC linker still not available.
    goto :MsvcManual
  )
) else (
  call "%~dp0scripts\setup-msvc-env.cmd"
)
echo  MSVC build environment ready.
echo.
goto :MsvcReady

:MsvcManual
echo.
echo  Install "Build Tools for Visual Studio 2022" with Desktop development with C++.
echo  Then run start-nhicode.cmd again.
echo.
pause
exit /b 1

:MsvcReady

if not exist "apps\desktop\src-tauri\icons\icon.ico" (
  echo  Generating app icons ^(first run^)...
  call pnpm --filter @nhicode/desktop icons 2>nul
)

echo  Starting NHI Code desktop app...
echo.
echo  Press Ctrl+C to stop.
echo.

call pnpm dev
set EXIT_CODE=!ERRORLEVEL!

echo.
if !EXIT_CODE! neq 0 (
  echo  NHI Code exited with an error ^(code !EXIT_CODE!^).
) else (
  echo  NHI Code stopped.
)
pause
exit /b !EXIT_CODE!

:FindNode
set "NODE_DIR="
if exist "%LocalAppData%\NHICode\nodejs\node.exe" set "NODE_DIR=%LocalAppData%\NHICode\nodejs"
if not defined NODE_DIR if exist "%LocalAppData%\SuprModl\nodejs\node.exe" set "NODE_DIR=%LocalAppData%\SuprModl\nodejs"
if not defined NODE_DIR if exist "%LocalAppData%\SuperModel\nodejs\node.exe" set "NODE_DIR=%LocalAppData%\SuperModel\nodejs"
if not defined NODE_DIR if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_DIR=%ProgramFiles%\nodejs"
if not defined NODE_DIR if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_DIR=%LocalAppData%\Programs\nodejs"
if not defined NODE_DIR (
  for /f "delims=" %%p in ('where node 2^>nul') do (
    set "NODE_DIR=%%~dpp"
    goto :FindNodeDone
  )
)
:FindNodeDone
exit /b 0

:InstallDeps
if not exist "node_modules\" (
  echo  Installing dependencies ^(first run^)...
) else (
  echo  Checking dependencies...
)
call pnpm install
if !ERRORLEVEL! equ 0 exit /b 0
echo  Retrying after approving esbuild build scripts...
call pnpm approve-builds esbuild --all 2>nul
call pnpm install
exit /b !ERRORLEVEL!
