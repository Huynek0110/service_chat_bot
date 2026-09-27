@echo off
chcp 65001 >nul <nul
cd /d %~dp0
if not exist backup mkdir backup
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set STAMP=%%I
copy "data\app.db" "backup\app-%STAMP%.db"
echo.
echo Da sao luu xong vao thu muc backup.
echo Muon phuc hoi: copy file backup de len data\app.db (khi server DANG TAT).
echo.
pause
