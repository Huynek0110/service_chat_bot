@echo off
chcp 65001 >nul <nul
cd /d %~dp0

rem ---------------------------------------------------------------
rem Kiem tra LM Studio TRUOC. Neu khong co thi dung lai ngay va
rem huong dan, thay vi mo ca hai cua so roi hai deu bao loi - doc
rem giup dung 1 lan.
rem
rem Luu y khi sua: trong khoi if ( ... ) cua cmd.exe, dau ) trong
rem lenh echo phai escape bang ^ ) hoac tot hon la dung goto de
rem tach khoi. Sai quy tac nay se bao loi
rem ". was unexpected at this time."
rem ---------------------------------------------------------------
curl.exe -s -o NUL --max-time 10 http://localhost:1234/v1/models >nul 2>&1
if errorlevel 1 goto LMSTUDIO_DOWN
goto LAUNCH

:LMSTUDIO_DOWN
echo ================================================
echo   LM STUDIO CHUA CHAY - DUNG LAI
echo ================================================
echo.
echo AI cua bot chay tren may ban, nen can LM Studio
echo truoc khi mo Server. Neu khong, bot se tra loi
echo loi ngay khi co khach nho tin.
echo.
echo Mo LM Studio roi lam:
echo.
echo   1. Tim model chat roi bam Download.
echo   2. Bam LOAD de nap model vao RAM.
echo      Chi Download thi chua du.
echo   3. Bam Start Server o tab Developer, port 1234.
echo   4. Bam lai file nay.
echo.
echo Muon xem huong dan day du:
echo   1-Kiem-Tra-LM-Studio.bat
echo.
pause
exit /b 1

:LAUNCH
echo [1/2] LM Studio OK. Dang mo Server + bot...
start "Chatbot Server" "2-Khoi-Dong-Server.bat"
echo.
echo Xong! Cho them khoang 15 giay roi mo trinh duyet vao:
echo   http://localhost:3000/admin
echo.
echo Se hien trang dang nhap. Dung ADMIN_USERNAME /
echo ADMIN_PASSWORD trong file .env.
echo Bot Telegram (neu da dien token trong .env) se tu noi theo.
echo Kiem tra server: http://localhost:3000/health
echo.
pause
