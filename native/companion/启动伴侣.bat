@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 灵犀互传 3.0 电脑端伴侣

echo ==========================================
echo  灵犀互传 3.0 商用版 · 电脑端伴侣
echo  作者：军哥懂保（微信：xunijiayuan）
echo ==========================================
echo.

python --version >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Python，请先安装 Python 3.8+ 并勾选 Add to PATH
  echo 下载地址: https://www.python.org/downloads/
  pause
  exit /b
)

echo [1/2] 检查依赖...
python -c "import websockets, PIL, pyautogui" >nul 2>nul
if errorlevel 1 (
  echo 正在安装依赖 websockets pillow pyautogui ...
  python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple websockets pillow pyautogui
)

echo [2/2] 启动伴侣...
echo.
python lanhub_companion.py

echo.
echo 程序已退出，按任意键关闭窗口
pause
