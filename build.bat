@echo off
echo Starting Lyra Build...
cd /d "%~dp0"
npm run build
echo.
echo Build finished! Press any key to close this window.
pause >nul
