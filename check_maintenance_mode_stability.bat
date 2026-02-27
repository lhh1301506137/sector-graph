@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "PS_CMD=powershell"
where pwsh >nul 2>nul
if %errorlevel%==0 (
  set "PS_CMD=pwsh"
)

echo [INFO] Running maintenance mode stability check...
set "BASE_URL=%~1"
set "RUNS=%~2"
set "INTERVAL_SEC=%~3"
if "%RUNS%"=="" set "RUNS=3"
if "%INTERVAL_SEC%"=="" set "INTERVAL_SEC=15"

set "BASE_ARG="
if not "%BASE_URL%"=="" (
  set "BASE_ARG=-BaseUrl %BASE_URL%"
)

echo [INFO] Command: %PS_CMD% -NoProfile -ExecutionPolicy Bypass -File scripts\run_maintenance_mode_stability.ps1 %BASE_ARG% -Runs %RUNS% -IntervalSec %INTERVAL_SEC%
%PS_CMD% -NoProfile -ExecutionPolicy Bypass -File scripts\run_maintenance_mode_stability.ps1 %BASE_ARG% -Runs %RUNS% -IntervalSec %INTERVAL_SEC%
set "EXIT_CODE=%errorlevel%"

if not "%EXIT_CODE%"=="0" (
  echo [FAIL] maintenance mode stability failed with exit code %EXIT_CODE%.
  exit /b %EXIT_CODE%
)

echo [PASS] maintenance mode stability finished.
exit /b 0
