@echo off
chcp 65001 >nul
setlocal
echo ========================================
echo   板块轮动预测系统 - 环境安装
echo ========================================
echo.

set "PY_EXE="

REM 1) 优先 Miniconda
if exist "%USERPROFILE%\miniconda3\python.exe" set "PY_EXE=%USERPROFILE%\miniconda3\python.exe"

REM 2) 回退 PATH
if not defined PY_EXE (
    for /f "delims=" %%I in ('where python 2^>nul') do (
        set "PY_EXE=%%I"
        goto :python_found
    )
)

:python_found
if not defined PY_EXE (
    echo ❌ Python未安装或版本过低，请先安装Python 3.9+
    pause
    exit /b 1
)

echo [1/2] 正在创建Python虚拟环境...
"%PY_EXE%" -m venv .venv-win
if errorlevel 1 (
    echo ❌ Python未安装或版本过低，请先安装Python 3.9+
    pause
    exit /b 1
)

echo [2/2] 正在安装依赖...
call .venv-win\Scripts\activate 2>nul
if errorlevel 1 (
    echo ❌ 虚拟环境激活失败，请检查执行环境
    pause
    exit /b 1
)
pip install -r server\requirements.txt
if errorlevel 1 (
    echo ❌ 依赖安装失败，请检查网络连接
    pause
    exit /b 1
)

echo.
echo ========================================
echo   ✅ 安装完成！请运行 start.bat 启动系统
echo ========================================
pause
