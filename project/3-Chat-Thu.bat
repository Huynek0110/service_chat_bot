@echo off
chcp 65001 >nul <nul
title Chat thu voi Bot
cd /d %~dp0
echo Dang mo che do chat thu truc tiep voi bot.
echo Go "exit" de thoat. Moi cau tra loi mat khoang 20-30 giay.
echo ------------------------------------------------
npm run cli
pause
