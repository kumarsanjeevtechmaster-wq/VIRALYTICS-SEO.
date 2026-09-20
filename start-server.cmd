@echo off
title Viralytics SEO Command Center
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   ✗ Node.js nahi mila.
  echo.
  echo   Pehle https://nodejs.org se "Node.js LTS" install karo
  echo   (Next - Next - Next - Install), phir ye wahi file dobara
  echo   double-click karo. Bas, itna hi karna hai.
  echo.
  pause
  exit /b 1
)

where python >nul 2>nul
if not errorlevel 1 goto run
where python3 >nul 2>nul
if not errorlevel 1 goto run
echo   Note: Python nahi mila — "Poori jaanch" report banane ke liye Python
echo   zaroori hai (https://www.python.org/downloads/). Bas dashboard
echo   abhi bhi chalega, box bhi chalega.
echo.

:run
echo   Viralytics dashboard chalu ho raha hai...
echo   Browser khud khul jaayega (http://localhost:8420).
echo   Band karne ke liye: bas ye window band karo.
echo.
start "" http://localhost:8420
node tools\go.js
echo.
echo   Server band ho gaya.
pause
