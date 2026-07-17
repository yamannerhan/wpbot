@echo off
chcp 65001 >nul
cd /d "%~dp0"
set SAHIBINDEN_API=https://wpbot-production-cf99.up.railway.app
echo.
echo Sahibinden Google giris - Chrome acilacak.
echo Google ile giris yap; bitince oturum Railway'e kaydedilecek.
echo Sonrasi otomatik (ekraninda tarayici acilmaz).
echo.
call pnpm sahibinden:login
echo.
pause
