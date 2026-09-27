@echo off
chcp 65001 >nul <nul
title Chatbot Server
cd /d %~dp0
if not exist data mkdir data
if not exist logs mkdir logs
if not exist backup mkdir backup
if not exist .env (
  echo Lan dau chay: tu tao file .env tu mau...
  copy .env.example .env >nul
  echo XONG. Nho mo file .env de dien token Facebook sau.
)
if not exist node_modules (
  echo Chua cai thu vien. Dang cai dat - chi lan dau, mat vai phut...
  npm install
  if errorlevel 1 (
    echo Cai thu vien THAT BAI. Thu lan luot:
    echo 1. Cai Visual Studio Build Tools roi chay lai file nay, hoac
    echo 2. Bao nguoi ho tro de duoc giup.
    pause
    exit /b 1
  )
)

rem ---------------------------------------------------------------
rem Kiem tra LM Studio. Bot can AI local nen khong co LM Studio
rem thi hoi thoai se loi. Default: KHONG chay Server, cho nguoi
rem dung quyet dinh vi cano.
rem
rem Luu y khi sua: trong khoi if ( ... ) cua cmd.exe, dau ) trong
rem lenh echo phai escape bang ^ ) hoac tot hon la dung goto de
rem tach khoi. Sai quy tac nay se bao loi
rem ". was unexpected at this time."
rem ---------------------------------------------------------------
curl.exe -s -o NUL --max-time 10 http://localhost:1234/v1/models >nul 2>&1
if errorlevel 1 goto LMSTUDIO_DOWN
goto FIRST_RUN

:LMSTUDIO_DOWN
echo ================================================
echo   CANH BAO: LM STUDIO CHUA CHAY
echo ================================================
echo.
echo AI cua bot chay tren may ban qua LM Studio
echo cong 1234. Chua co LM Studio thi Server se len
echo duoc nhung hoi thoai se bao loi.
echo.
echo Chay 1-Kiem-Tra-LM-Studio.bat de xem huong dan
echo day du, hoac lam dung thu tu:
echo.
echo   1. Mo LM Studio, tim model va bam Download.
echo   2. Bam LOAD de nap model vao RAM.
echo      Chi Download thi chua du.
echo   3. Bam Start Server o tab Developer, port 1234.
echo.
set /p GO="Van muon mo Server de vao Admin sua cau hinh? (C/N): "
if /i "%GO%"=="C" goto FIRST_RUN
if /i "%GO%"=="Y" goto FIRST_RUN
echo.
echo Da dung. Bat LM Studio roi chay lai file nay.
echo.
pause
exit /b 0

:FIRST_RUN
if not exist data\app.db (
  echo Lan dau chay: dang dung database + du lieu mau...
  echo Buoc 1/3: tao bang...
  npm run migrate
  echo Buoc 2/3: nhap hang mau...
  npm run seed
  echo Buoc 3/3: nap du lieu vao AI...
  echo (Buoc nay BO QUA duoc neu .env de trong LMSTUDIO_EMBEDDING_MODEL
  echo  - tuc la RAG dang TAT, van chat binh thuong. Muon bat RAG xem
  echo  file 0-Cai-Dat-LM-Studio-Model.bat muc [3].)
  node -e "import('./src/rag/indexer.js').then(m => m.reindexAll()).then(() => console.log('XONG INDEX')).catch(e => { console.error('BO QUA INDEX:', e.message); })"
  echo XONG database lan dau.
)
echo Dang khoi dong server...
echo Xong thi mo trinh duyet vao: http://localhost:3000/admin
echo (Se hien trang dang nhap. Dung ADMIN_USERNAME /
echo  ADMIN_PASSWORD trong file .env.)
echo KHONG TAT cua so nay khi dang dung bot.
npm start
pause
