@echo off
chcp 65001 >nul <nul
title Ngrok Tunnel (Messenger Webhook)
cd /d %~dp0
where ngrok >nul 2>&1
if errorlevel 1 (
  echo Chua thay ngrok. Chay file 0-Cai-Dat-Ollama-Model.bat muc [4] de cai.
  echo Mo PowerShell chay: winget install -e --id Ngrok.Ngrok
  echo Hoac tai tay tai: https://ngrok.com/download
  pause
  exit /b 1
)
if not exist "%USERPROFILE%\.ngrok2\ngrok.yml" if not exist "%LOCALAPPDATA%\ngrok\ngrok.yml" (
  echo Chua co authtoken ngrok. Lam 1 lan duy nhat:
  echo   1. Dang ky mien phi tai https://ngrok.com
  echo   2. Vao Dashboard -^> Your Authtoken -^> copy ma token
  echo   3. Mo PowerShell, chay lenh:
  echo      ngrok config add-authtoken MA_TOKEN_CUA_BAN
  echo   4. Chay lai file nay.
  pause
  exit /b 1
)
echo Dang mo duong dan HTTPS toi server (cong 3000)...
echo GIU NGUYEN cua so nay. Link hien ra dung de dang ky webhook Facebook.
echo Chu y: ban mien phi DOI LINK moi lan tat/mo lai.
echo.
ngrok http 3000
pause
