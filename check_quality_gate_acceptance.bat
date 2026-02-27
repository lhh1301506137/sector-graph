@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "PS_CMD=powershell"
where pwsh >nul 2>nul
if %errorlevel%==0 (
  set "PS_CMD=pwsh"
)

echo [INFO] Running quality gate acceptance...
echo [INFO] Command: %PS_CMD% -NoProfile -ExecutionPolicy Bypass -File scripts\run_quality_gate_acceptance.ps1
%PS_CMD% -NoProfile -ExecutionPolicy Bypass -File scripts\run_quality_gate_acceptance.ps1
set "EXIT_CODE=%errorlevel%"

if not "%EXIT_CODE%"=="0" (
  echo [FAIL] quality gate acceptance failed with exit code %EXIT_CODE%.
  exit /b %EXIT_CODE%
)

echo [PASS] quality gate acceptance finished.
exit /b 0
