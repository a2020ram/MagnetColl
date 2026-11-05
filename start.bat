@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo http://127.0.0.1:8765/
echo Закройте это окно, чтобы остановить страницу.
start "" http://127.0.0.1:8765/
python serve.py
if errorlevel 1 pause
