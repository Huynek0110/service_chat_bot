@echo off
chcp 65001 >nul <nul
title Kiem tra LM Studio (Chatbot)
cd /d %~dp0

rem Doc ten model chat tu .env de thong bao khop cau hinh thuc te
set "CHAT_MODEL=google/gemma-3-1b"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if "%%A"=="LMSTUDIO_CHAT_MODEL" set "CHAT_MODEL=%%B"
  )
)
set "CHAT_MODEL=%CHAT_MODEL:"=%"

curl.exe -s -o NUL -w "%%{http_code}" --max-time 10 http://localhost:1234/v1/models > tmp_lmstudio.txt 2>nul
set /p LMSTUDIO_CODE=<tmp_lmstudio.txt
del tmp_lmstudio.txt >nul 2>&1

if not "%LMSTUDIO_CODE%"=="200" (
  echo ================================================
  echo LM Studio CHUA CHAY tren cong 1234.
  echo.
  echo Lam dung thu tu:
  echo   1. Mo phan mem LM Studio (cai 1 lan tai
  echo      https://lmstudio.ai/download).
  echo   2. Trong LM Studio, tim model chat
  echo      "%CHAT_MODEL%" roi bam Download
  echo      neu may chua co san.
  echo   3. Bam "Load" de nap model vao RAM.
  echo      ^< Download ma chua Load thi van loi ^)
  echo   4. Bam "Start Server" (tab Developer), chon port
  echo      1234, bat "Local Server". GIU NGUYEN LM Studio.
  echo   5. Mo lai file nay.
  echo.
  echo KHONG TAT cua so nay khi dang dung bot.
  echo.
  pause
  start "" https://lmstudio.ai/download
  exit /b 1
)

rem Server da len, nhung phai kiem tra model co that trong danh sach
curl.exe -s --max-time 20 http://localhost:1234/v1/models -o tmp_lm_models.json >nul 2>&1
findstr /i /c:"%CHAT_MODEL%" tmp_lm_models.json >nul 2>&1
if errorlevel 1 (
  del tmp_lm_models.json >nul 2>&1
  echo ================================================
  echo LM Studio DA CHAY nhung model chat CHUA LOAD.
  echo.
  echo   Can co: %CHAT_MODEL%
  echo.
  echo   Trong LM Studio:
  echo     1. Tim model "%CHAT_MODEL%" roi bam Download
  echo        neu chua co.
  echo     2. Bam "LOAD" de nap model vao RAM.
  echo     3. Bam "Start Server" (port 1234).
  echo     4. Mo lai file nay.
  echo.
  echo   Chu y: chi Download chua du. Bai "Load" moi nap
  echo   model vao RAM va cho server tra loi duoc.
  echo.
  pause
  exit /b 1
)
del tmp_lm_models.json >nul 2>&1

echo ================================================
echo [OK] LM Studio dang chay tren cong 1234.
echo [OK] Model chat da LOAD: %CHAT_MODEL%
echo.
echo Bat dau chatbot:
echo   2-Khoi-Dong-Server.bat   (Server + bot)
echo   Khoi-Dong-Tat-Ca.bat     (LM Studio + Server + bot)
echo.
echo Cua so nay co the dong lai.
echo ================================================
pause
exit /b 0
