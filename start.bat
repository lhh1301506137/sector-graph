@echo off
setlocal

echo [INFO] Starting sector-graph...

set "PY_EXE="

if exist ".venv-win\Scripts\python.exe" set "PY_EXE=.venv-win\Scripts\python.exe"
if not defined PY_EXE if exist "venv\Scripts\python.exe" set "PY_EXE=venv\Scripts\python.exe"
if not defined PY_EXE if exist "%USERPROFILE%\miniconda3\python.exe" set "PY_EXE=%USERPROFILE%\miniconda3\python.exe"

if not defined PY_EXE (
    for /f "delims=" %%I in ('where python 2^>nul') do (
        set "PY_EXE=%%I"
        goto :have_python
    )
)

:have_python
if not defined PY_EXE (
    echo [ERROR] Python not found. Please install Python 3.9+.
    pause
    exit /b 1
)

"%PY_EXE%" -c "import fastapi,uvicorn" >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Missing dependencies in "%PY_EXE%".
    echo [HINT] Run setup.bat first.
    pause
    exit /b 1
)

echo [INFO] Using Python: %PY_EXE%

set "APP_HOST=127.0.0.1"
set "APP_PORT="

for %%P in (8000 18008 18080 18081) do (
    powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %%P -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }" >nul 2>nul
    if not errorlevel 1 (
        set "APP_PORT=%%P"
        goto :port_selected
    )
)

set "APP_PORT=18008"

:port_selected
echo [INFO] Selected port: %APP_PORT%
echo [INFO] URL: http://%APP_HOST%:%APP_PORT%

if not defined SG_NO_BROWSER (
    start "" http://%APP_HOST%:%APP_PORT%
)

set "APP_HOST=%APP_HOST%"
set "APP_PORT=%APP_PORT%"
"%PY_EXE%" -m uvicorn server.app:app --host %APP_HOST% --port %APP_PORT%
