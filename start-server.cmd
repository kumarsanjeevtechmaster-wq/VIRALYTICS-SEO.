@echo off
title Viralytics - Local SEO Dashboard
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   x  Node.js nahi mila.
  echo.
  echo   Pehle Node.js install karo (free):  https://nodejs.org
  echo   Wahan bada button "Download Node.js (LTS)" dabao, phir installer
  echo   mein sirf Next-Next-Next-Install-Finish dabate jao.
  echo   Install hone ke baad ye file dobara double-click karo.
  echo.
  pause
  exit /b 1
)

echo.
echo   Viralytics dashboard chalu ho raha hai...
echo   Browser khud khulega (http://localhost:8420).
echo   Band karne ke liye: bas ye kaali window band kar do.
echo.
start "" http://localhost:8420
node tools\go.js
pause
