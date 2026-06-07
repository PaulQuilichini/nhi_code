@echo off
REM Install Visual Studio 2022 Build Tools (C++). Run as Administrator if winget fails.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-msvc.ps1"
pause
