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
curl.exe -s -o NUL http://localhost:1234/v1/models >nul 2>&1
if errorlevel 1 (
  echo ================================================
  echo CANH BAO: LM Studio chua chay tren cong 1234!
  echo Hay mo LM Studio, bat "Local Server" port 1234,
  echo roi moi chay lai file nay.
  echo Server van chay duoc, chi la bot se bao loi.
  echo ================================================
  pause
  exit /b 1
)
if not exist data\app.db (
  echo Lan dau chay: dang dung database + du lieu mau...
  echo Buoc 1/3: tao bang...
  npm run migrate
  echo Buoc 2/3: nhap hang mau...
  npm run seed
  echo Buoc 3/3: nap du lieu vao AI...
  echo (Buoc nay BO QUA duoc neu .env de trong LMSTUDIO_EMBEDDING_MODEL
  echo  - tuc la RAG dang TAT, van chat binh thuong. Muon bat RAG xem
  echo  file 0-Cai-Dat-Ollama-Model.bat muc [3].)
  node -e "import('./src/rag/indexer.js').then(m => m.reindexAll()).then(() => console.log('XONG INDEX')).catch(e => { console.error('BO QUA INDEX:', e.message); })"
  echo XONG database lan dau.
)
echo Dang khoi dong server...
echo Xong thi mo trinh duyet vao: http://localhost:3000/admin
echo (Se hien trang dang nhap. Dang nhap bang ADMIN_USERNAME /
echo  ADMIN_PASSWORD trong file .env.)
echo KHONG TAT cua so nay khi dang dung bot.
npm start
pause
