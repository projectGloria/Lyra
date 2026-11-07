@echo off
:: Lyra release builder - double-click to produce the NSIS installer + a portable exe.
:: Output lands in .\release\ and Explorer opens on it when done.
setlocal EnableExtensions EnableDelayedExpansion

:: Double-click starts in an arbitrary cwd (often System32 when elevated); pin it to the repo root.
cd /d "%~dp0"

set "ROOT=%~dp0"
:: Not named TARGET: cargo/tauri-codegen read the TARGET env var as the Rust target triple.
set "REL_DIR=%ROOT%src-tauri\target\release"
set "NSIS_DIR=%REL_DIR%\bundle\nsis"
set "OUT=%ROOT%release"

echo.
echo ===============================================
echo   Lyra - building installer + portable
echo ===============================================
echo.

:: --- Toolchain sanity checks: fail fast with a readable message instead of a cryptic cargo dump.
where node >nul 2>&1 || (echo [ERROR] Node.js not found on PATH. & goto :fail)
where cargo >nul 2>&1 || (echo [ERROR] Rust/Cargo not found on PATH. Install via https://rustup.rs & goto :fail)

:: Version comes from tauri.conf.json so the file names never drift from the actual bundle.
for /f "usebackq delims=" %%V in (`node -p "require('./src-tauri/tauri.conf.json').package.version"`) do set "VERSION=%%V"
if not defined VERSION (echo [ERROR] Could not read version from tauri.conf.json. & goto :fail)
echo Version: %VERSION%
echo.

:: npm is npm.cmd - without CALL, control never returns to this script.
if not exist "%ROOT%node_modules\@tauri-apps\cli" (
    echo [1/3] Installing npm dependencies...
    call npm install || goto :fail
) else (
    echo [1/3] npm dependencies present, skipping install.
)

echo.
echo [2/3] Running tauri build ^(this takes a while on a cold cache^)...
echo.
call npm run build
if errorlevel 1 (echo. & echo [ERROR] tauri build failed. & goto :fail)

echo.
echo [3/3] Collecting artifacts into .\release ...
if not exist "%OUT%" mkdir "%OUT%"

:: Pick the newest *-setup.exe; old versions can linger in bundle\nsis between builds.
set "SETUP_SRC="
for /f "delims=" %%F in ('dir /b /o-d "%NSIS_DIR%\*-setup.exe" 2^>nul') do (
    if not defined SETUP_SRC set "SETUP_SRC=%NSIS_DIR%\%%F"
)
if not defined SETUP_SRC (echo [ERROR] No installer found in "%NSIS_DIR%". & goto :fail)

set "SETUP_OUT=%OUT%\Lyra_%VERSION%_x64-setup.exe"
set "PORTABLE_OUT=%OUT%\Lyra_%VERSION%_x64-portable.exe"

copy /y "!SETUP_SRC!" "%SETUP_OUT%" >nul || goto :fail

:: Tauri v1 has no portable target; the raw release binary IS the portable build
:: (frontend assets are embedded, WebView2 ships with Win10/11).
if not exist "%REL_DIR%\Lyra.exe" (echo [ERROR] "%REL_DIR%\Lyra.exe" not found. & goto :fail)
copy /y "%REL_DIR%\Lyra.exe" "%PORTABLE_OUT%" >nul || goto :fail

echo.
echo ===============================================
echo   BUILD SUCCEEDED
echo ===============================================
echo.
echo   Installer : %SETUP_OUT%
echo   Portable  : %PORTABLE_OUT%
echo.
echo   Note: the portable exe still stores settings in %%APPDATA%%\com.lyra.sona
echo.

:: /select highlights the installer in the opened Explorer window.
explorer /select,"%SETUP_OUT%"
pause
exit /b 0

:fail
echo.
echo ===============================================
echo   BUILD FAILED - see output above
echo ===============================================
pause
exit /b 1
