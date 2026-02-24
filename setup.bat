@echo off
chcp 65001 >nul
echo ========================================
echo   板块轮动预测系统 - 环境安装
echo ========================================
echo.

echo [1/2] 正在创建Python虚拟环境...
python -m venv venv
if errorlevel 1 (
    echo ❌ Python未安装或版本过低，请先安装Python 3.9+
    pause
    exit /b 1
)

echo [2/2] 正在安装依赖...
call venv\bin\activate 2>nul || call venv\Scripts\activate 2>nul
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
