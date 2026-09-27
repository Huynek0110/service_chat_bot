@echo off
chcp 65001 >nul <nul
cd /d %~dp0
echo [1/2] Dang mo LM Studio...
start "LM Studio" "1-Khoi-Dong-Ollama.bat"
timeout /t 12 /nobreak >nul
echo [2/2] Dang mo Server...
start "Chatbot Server" "2-Khoi-Dong-Server.bat"
echo.
echo Xong! Cho them khoang 20 giay roi mo trinh duyet vao:
echo http://localhost:3000/admin
echo Bot Telegram (neu da dien token trong .env) se tu noi theo.
echo Kiem tra tai: http://localhost:3000/health
echo.
pause
