@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "PY_CMD="

if exist ".venv-win\Scripts\python.exe" (
  set "PY_CMD=.venv-win\Scripts\python.exe"
) else if exist "venv\Scripts\python.exe" (
  set "PY_CMD=venv\Scripts\python.exe"
) else if exist "%USERPROFILE%\miniconda3\python.exe" (
  set "PY_CMD=%USERPROFILE%\miniconda3\python.exe"
) else if exist "%USERPROFILE%\anaconda3\python.exe" (
  set "PY_CMD=%USERPROFILE%\anaconda3\python.exe"
) else (
  where python >nul 2>nul
  if %errorlevel%==0 (
    set "PY_CMD=python"
  ) else (
    where py >nul 2>nul
    if %errorlevel%==0 (
      set "PY_CMD=py -3"
    )
  )
)

if not defined PY_CMD (
  echo [FAIL] Python not found. Please install Python 3.9+ and try again.
  exit /b 1
)

%PY_CMD% -c "import uvicorn" >nul 2>nul
if not "%errorlevel%"=="0" (
  echo [FAIL] Selected Python does not have uvicorn: %PY_CMD%
  echo [HINT] Install deps or use venv/miniconda interpreter.
  exit /b 1
)

echo [INFO] Running quality gate smoke test...
echo [INFO] Command: %PY_CMD% scripts\quality_gate_smoke.py --start-server --host 127.0.0.1 --port 18001 --source sina --exercise-blocked-case --exercise-failed-rows-case
%PY_CMD% scripts\quality_gate_smoke.py --start-server --host 127.0.0.1 --port 18001 --source sina --exercise-blocked-case --exercise-failed-rows-case
set "EXIT_CODE=%errorlevel%"

if not "%EXIT_CODE%"=="0" (
  echo [FAIL] quality gate smoke test failed with exit code %EXIT_CODE%.
  exit /b %EXIT_CODE%
)

echo [PASS] quality gate smoke test finished.
exit /b 0
