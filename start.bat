@echo off
chcp 65001 >nul
echo 🚀 正在启动板块轮动预测系统...

REM 尝试多种Python路径
where python >nul 2>nul
if %errorlevel%==0 (
    start http://localhost:8000
    python -m server.app
) else (
    echo ❌ Python未找到，请先安装Python 3.9+
    pause
)
