@echo off
chcp 65001 >nul <nul
title Kiem tra LM Studio
cd /d %~dp0

rem ---------------------------------------------------------------
rem Script nay KHONG the bat LM Studio duoc - LM Studio la app
rem GUI, phai do nguoi dung mo tay. Vai tro cua script la:
rem   1. kiem tra server cong 1234 co len khong
rem   2. kiem tra model chat da LOAD chua (Download chua du)
rem   3. neu thieu thi huong dan cu the
rem
rem Luu y khi sua: trong khoi if ( ... ) cua cmd.exe, dau ) trong
rem lenh echo phai escape bang ^ ) hoac tot hon la dung goto de
rem tach khoi, nhu file nay dang lam. Sai quy tac nay se bao loi
rem ". was unexpected at this time."
rem ---------------------------------------------------------------

set "CHAT_MODEL=google/gemma-3-1b"
if exist ".env" goto READENV
goto CHECKSERVER

:READENV
for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
  if "%%A"=="LMSTUDIO_CHAT_MODEL" set "CHAT_MODEL=%%B"
)
rem bo dau nhay double neu co
set "CHAT_MODEL=%CHAT_MODEL:"=%"
goto CHECKSERVER

rem --- Buoc 1: server co len khong ---
:CHECKSERVER
curl.exe -s -o NUL -w "%%{http_code}" --max-time 10 http://localhost:1234/v1/models > tmp_lmstudio.txt 2>nul
set /p LMSTUDIO_CODE=<tmp_lmstudio.txt
del tmp_lmstudio.txt >nul 2>&1
if "%LMSTUDIO_CODE%"=="200" goto CHECKMODEL
goto SERVER_DOWN

rem --- Buoc 2: model da co trong danh sach server phuc vu khong ---
rem (da Load = co trong danh sach; chi Download thi khong co)
:CHECKMODEL
curl.exe -s --max-time 20 http://localhost:1234/v1/models -o tmp_lm_models.json >nul 2>&1
if not exist tmp_lm_models.json goto SERVER_DOWN
rem Luu ket qua findstr TRUOC khi xoa file. `del` luon reset errorlevel
rem ve 0, nen phai gan bien truoc roi moi xoa - neu xoa truoc thi nhanh
rem "chua Load" se khong bao gio chay.
findstr /i /c:"%CHAT_MODEL%" tmp_lm_models.json >nul 2>&1
set "MODEL_STATUS=missing"
if not errorlevel 1 set "MODEL_STATUS=present"
del tmp_lm_models.json >nul 2>&1
if "%MODEL_STATUS%"=="present" goto ALL_OK
goto MODEL_NOT_LOADED

:SERVER_DOWN
echo ================================================
echo   LM STUDIO CHUA CHAY tren cong 1234
echo ================================================
echo.
echo Server cua LM Studio chua mo. Lam dung thu tu:
echo.
echo   1. Mo phan mem LM Studio.
echo      Tai lan dau tai https://lmstudio.ai/download
echo.
echo   2. Trong LM Studio, tim model chat
echo         %CHAT_MODEL%
echo      roi bam Download neu may chua co san.
echo.
echo   3. Bam LOAD de nap model vao RAM.
echo      QUAN TRONG: chi Download thi chua du, phai
echo      bam Load them mot lan nua.
echo.
echo   4. Bam Start Server o tab Developer, chon port 1234.
echo.
echo   5. Mo lai file nay de kiem tra lai.
echo.
echo KHONG TAT cua so LM Studio khi dang dung bot.
echo.
pause
start "" https://lmstudio.ai/download
exit /b 1

:MODEL_NOT_LOADED
echo ================================================
echo   MODEL CHAT CHUA DUOC LOAD
echo ================================================
echo.
echo Server da chay, nhung khong thay model
echo   %CHAT_MODEL%
echo trong danh sach no phuc vu.
echo.
echo Nguyen nhan thuong gap:
echo.
echo   - Ban moi Download, chua bam Load. Bam LOAD
echo     de nap model vao RAM. Chi Download thi server
echo     van tra loi rong.
echo.
echo   - Da Load nhung ten khac. Xem danh sach server
echo     thuc su phuc vu:
echo       curl http://localhost:1234/v1/models
echo     roi sua file .env cho khop ten that:
echo       LMSTUDIO_CHAT_MODEL^=ten-that
echo     Luu .env roi khoi dong lai Server.
echo.
echo   - Server phuc vu nhieu model, thuong model vua
echo     Load nam o dau danh sach. Cu lon xuong va thu
echo     lai.
echo.
pause
exit /b 1

:ALL_OK
echo ================================================
echo   SAN SANG
echo ================================================
echo.
echo   LM Studio: dang chay cong 1234
echo   Model chat: %CHAT_MODEL%
echo.
echo Bat dau chatbot:
echo   2-Khoi-Dong-Server.bat   - Server + bot
echo   Khoi-Dong-Tat-Ca.bat     - mo ca hai
echo.
echo Cua so nay co the dong lai.
echo.
pause
exit /b 0
