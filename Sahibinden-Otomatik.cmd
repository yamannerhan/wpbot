@echo off
cd /d "%~dp0"
set SAHIBINDEN_API=https://wpbot-production-cf99.up.railway.app
set SAHIBINDEN_AUTO=1
call pnpm sahibinden:auto >> "scripts\sahibinden-auto.log" 2>&1
