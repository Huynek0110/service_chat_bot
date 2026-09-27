@echo off
chcp 65001 >nul <nul
title Cai dat LM Studio + Model + Ngrok
cd /d %~dp0

rem ---------------------------------------------------------------
rem Doc ten model chat tu .env de file nay KHONG BAO GIO LECH VOI
rem cau hinh thuc te. Neu .env khong co -> dung gia tri mac dinh.
rem ---------------------------------------------------------------
set "CHAT_MODEL=google/gemma-3-1b"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if "%%A"=="LMSTUDIO_CHAT_MODEL" set "CHAT_MODEL=%%B"
  )
)
rem bo dau nhay double neu co
set "CHAT_MODEL=%CHAT_MODEL:"=%"

echo ==================================================
echo CAI DAT 1 LAN DUY NHAT cho may moi
echo  AI local chay bang LM Studio (API chuan OpenAI, cong 1234):
echo   - Chat (BAT BUOC): %CHAT_MODEL%
echo   - Embedding (TUY CHON): text-embedding-nomic-embed-text-v1.5
echo     De trong .env se TAT RAG - bot van chat binh thuong.
echo  Ngrok: tao link HTTPS de Facebook goi ve may ban
echo ==================================================
echo.

echo [1/3] Cai LM Studio (chi 1 lan, neu may chua co):
echo   - Mo trinh duyet tai: https://lmstudio.ai/download
echo   - Cai xong, BAT LM Studio va cho no mo xong.
echo   - Trong LM Studio: tim model chat "%CHAT_MODEL%"
echo     roi bam Download (mat vai phut). Chi can MOT ban co san.
echo   - Bam nut "Start Server" (tab Developer), chon port 1234,
echo     bat "Local Server". Giu nguyen cua so nay.
echo.

curl.exe -s -o NUL http://localhost:1234/v1/models >nul 2>&1
if errorlevel 1 (
  echo [2/3] LM Studio CHUA CHAY tren cong 1234.
  echo       Hay mo LM Studio roi bat Local Server tren port 1234,
  echo       roi chay lai file nay.
  echo       Tai LM Studio tai: https://lmstudio.ai/download
  pause
  exit /b 1
)
echo [OK] LM Studio dang chay tren cong 1234.

echo.
echo Chon muc can lam:
echo   [1] Huong dan load model chat %CHAT_MODEL%
echo   [2] Kiem tra model da duoc LOAD chua
echo   [3] Bat/TAT RAG (them model embedding vao .env)
echo   [4] Ngrok: cai dat + nhap authtoken - de tao link HTTPS
echo   [5] Xem cac model LM Studio dang phuc vu
set /p LUA="Nhap 1, 2, 3, 4 hoac 5 roi Enter: "

if "%LUA%"=="1" goto AIMODEL
if "%LUA%"=="2" goto CHECKMODEL
if "%LUA%"=="3" goto RAG
if "%LUA%"=="4" goto NGROK
if "%LUA%"=="5" goto LIST
echo Lua chon khong hop le.
pause
exit /b 1

:AIMODEL
echo.
echo ==================================================
echo CACH LOAD MODEL CHAT %CHAT_MODEL%
echo.
echo   1. Mo LM Studio, vao o tim kiem (Search).
echo   2. Go dung ten: %CHAT_MODEL%
echo      (Neu LM Studio hien ten khac, xem muc [2] de biet
echo       ten server THUC SU dang phuc vu roi sua .env theo.)
echo   3. Bam "Download". Cho chay xong.
echo   4. Bam "Load" de LM Studio nap model vao RAM.
echo      ^< QUAN TRONG: Download xong ma chua Load thi
echo        server van tra loi rong ^)
echo   5. Bam "Start Server" neu chua bat (port 1234).
echo.
echo LOI THUONG GAP:
echo   - LM Studio chay nhe, GPU it RAM cung duoc
echo     (model 1B rat nho, khong can GPU manh).
echo   - RAM: can it nhat 4GB trong, 8GB de lam viec
echo     thoai may.
echo   - Mo nhieu model cung luc se vong RAM. Chi Load
echo     MOT model chat tai mot luc.
echo.
echo Kiem tra nhanh: chay lai file nay va chon muc [2].
echo ==================================================
pause
exit /b 0

:CHECKMODEL
echo.
echo ==================================================
echo KIEM TRA MODEL DA LOAD CHUA
echo.
echo Server se tra ve danh sach model THUC SU dang phuc vu.
echo Model chi xuat hien khi da bam "Load" trong LM Studio.
echo.
call :DUMP_MODELS
echo.
echo Ban can thay: %CHAT_MODEL%
echo.
findstr /i /c:"%CHAT_MODEL%" tmp_models.json >nul 2>&1
if errorlevel 1 (
  echo [SAI] KHONG thay "%CHAT_MODEL%" trong danh sach tren.
  echo.
  echo   1. Ban da Download nhung chua Load? Bam "Load".
  echo   2. LM Studio hien ten khac? Copy dung ten trong danh
  echo      sach tren, mo .env bang Notepad, sua:
  echo        LMSTUDIO_CHAT_MODEL^=ten-that
  echo      Luu lai roi chay lai muc nay.
  echo   3. Server co the phuc vu nhieu model - cu lon
  echo      xuong dau danh sach thuong la model vua Load.
  del tmp_models.json >nul 2>&1
  echo ==================================================
  pause
  exit /b 0
)
del tmp_models.json >nul 2>&1
echo [OK] Da tim thay "%CHAT_MODEL%".
echo.
echo --- Thu chat 1 lan de chan doan chat co chay khong ---
echo.
echo (Neu may treo qua 60 giay, model 1B chua duoc Load
echo  hoac may dang qua thieu RAM. Bam Ctrl+C de huy.)
echo.
echo.
curl.exe -s --max-time 90 http://localhost:1234/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"%CHAT_MODEL%\",\"stream\":false,\"max_tokens\":40,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: OK\"}]}"
echo.
echo.
echo Ban thay chu OK o tren la may chay dung.
echo ==================================================
pause
exit /b 0

:RAG
echo.
echo ==================================================
echo RAG (tra cuu san pham/FAQ tu database)
echo.
echo MAC DINH: TAT. Bot van chat binh thuong, chi khong
echo tu dong tra cuu du lieu trong database.
echo.
echo BAT RAG (can 1 lan):
echo   1. Trong LM Studio: tim va Download model embedding, vd
echo      text-embedding-nomic-embed-text-v1.5 (nho hon chat model).
echo   2. Mo file .env bang Notepad, sua 2 dong:
echo      LMSTUDIO_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
echo      EMBEDDING_DIM=768
echo   3. Luu, khoi dong lai Server, vao /admin -^> Products
echo      -^> Import lai hang (hoac chay lai lenh index ben duoi).
echo.
echo Lenh nap lai toan bo kien thuc RAG (1 lan):
echo   node -e "import('./src/rag/indexer.js').then(m=>m.reindexAll())"
echo.
echo KHUYEN NGHI: doi EMBEDDING_DIM phai xoa kb_vectors + kb_chunks
echo roi nap lai bang 1 model duy nhat, neu khong se bao loi.
echo ==================================================
pause
exit /b 0

:NGROK
echo.
where ngrok >nul 2>&1
if errorlevel 1 (
  echo Chua thay ngrok. Dang cai tu dong qua winget...
  winget install -e --id Ngrok.Ngrok --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo.
    echo Cai tu dong THAT BAI. Hay tai tay tai:
    echo https://ngrok.com/download
    pause
    exit /b 1
  )
  echo [OK] Da cai xong ngrok. Dong cua so nay, mo lai cmd moi roi chay lai file nay muc 4.
  echo Ly do: Windows can nap lai duong dan moi cai.
  pause
  exit /b 0
)
echo [OK] Da co ngrok.
if exist "%USERPROFILE%\.ngrok2\ngrok.yml" (
  echo [OK] Da co authtoken tu truoc, khong can nhap lai.
  goto NGROK_DONE
)
echo.
echo Lay authtoken MIEN PHI 1 lan duy nhat:
echo   Buoc 1: vao https://ngrok.com - dang ky tai khoan
echo   Buoc 2: vao Dashboard, muc Your Authtoken, bam copy
echo   Buoc 3: dan ma token vao day roi Enter
echo.
set /p NGROK_TOKEN="Dan authtoken ngrok vao day: "
if "%NGROK_TOKEN%"=="" (
  echo Chua nhap token. Chay lai muc 4 khi co token.
  pause
  exit /b 1
)
ngrok config add-authtoken %NGROK_TOKEN%
if errorlevel 1 (
  echo Luu token THAT BAI. Kiem tra lai ma token roi chay lai muc 4.
  pause
  exit /b 1
)
:NGROK_DONE
echo.
echo ==================================================
echo XONG NGROK! Mo link HTTPS hang ngay bang file:
echo   4-Mo-Ngrok.bat
echo No se hien link dang https://....ngrok-free.app
echo Dan link do + /webhook/messenger vao Facebook App Dashboard.
echo Chu y: ban mien phi DOI LINK moi lan tat/mo lai.
echo ==================================================
pause
exit /b 0

:LIST
echo.
echo Cac model LM Studio dang phuc vu (GET /v1/models):
call :DUMP_MODELS
echo.
echo Model bat buoc phai co ten day du: %CHAT_MODEL%
pause
exit /b 0

rem Lay danh sach model, co fallback neu file tam ton tai
:DUMP_MODELS
curl.exe -s --max-time 20 http://localhost:1234/v1/models -o tmp_models.json >nul 2>&1
if not exist tmp_models.json (
  echo Khong goi duoc server. Hay bat Local Server port 1234.
  exit /b 1
)
type tmp_models.json
exit /b 0
