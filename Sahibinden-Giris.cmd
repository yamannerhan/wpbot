@echo off
chcp 65001 >nul
cd /d "%~dp0"
set SAHIBINDEN_API=https://wpbot-production-cf99.up.railway.app
echo.
echo ============================================
echo  Sahibinden - Google Giris + Ilan Cekimi
echo ============================================
echo 1) Acilan Chrome'da GOOGLE ile giris yap
echo 2) Guvenlik gorevlisi ILAN LISTESINI gor
echo 3) Bu siyah pencereye donup ENTER'a bas
echo 4) Ilanlar otomatik cekilip Railway'e yazilir
echo.
call pnpm sahibinden:login
echo.
pause
