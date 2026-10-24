@echo off
rem Build debug APK for the project monitor app.
rem NOTE: keep this file ASCII-only. A .bat containing Chinese may be parsed
rem with the OEM code page and garbled on some Windows setups.

cd /d "%~dp0android"

call gradlew.bat assembleDebug --no-daemon --console=plain
if errorlevel 1 (
  echo.
  echo [ERROR] Build failed. Scroll up for details.
  pause
  exit /b 1
)

if not exist "%~dp0dist" mkdir "%~dp0dist"
copy /y "app\build\outputs\apk\debug\app-debug.apk" "%~dp0dist\app-debug.apk" >nul

echo.
echo [OK] APK ready: %~dp0dist\app-debug.apk
echo.
pause
