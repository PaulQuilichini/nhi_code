@echo off
REM Returns 0 if link.exe is available for Rust MSVC builds
where link.exe >nul 2>&1
if %ERRORLEVEL% equ 0 exit /b 0

if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" (
  for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find VC\Tools\MSVC\**\bin\Hostx64\x64\link.exe 2^>nul`) do (
    if exist "%%i" exit /b 0
  )
)
exit /b 1
