@echo off
setlocal EnableExtensions
rem ============================================================================
rem  Download a portable Node.js runtime into ..\runtime\node
rem
rem   - uses curl.exe (bundled with Windows 10 1803+) or PowerShell as fallback
rem   - tries a domestic mirror first, then the official nodejs.org
rem   - extracts with tar.exe (bundled) or PowerShell Expand-Archive
rem   - never touches anything outside ..\runtime
rem
rem  Keep this file ASCII-only (see find-node.bat for why).
rem  Exit code: 0 = runtime ready, 1 = failed
rem ============================================================================

for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "RUNTIME=%ROOT%\runtime"
set "NODEDIR=%RUNTIME%\node"
set "NODEVER=v22.11.0"
set "TMPZIP=%TEMP%\dev-monitor-node.zip"
set "EXTRACT=%TEMP%\dev-monitor-node-x"

if exist "%NODEDIR%\node.exe" (
  echo   [i] Portable Node.js runtime already present:
  echo       %NODEDIR%\node.exe
  exit /b 0
)

rem --- target architecture -----------------------------------------------------
set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"

set "URL1=https://npmmirror.com/mirrors/node/%NODEVER%/node-%NODEVER%-win-%ARCH%.zip"
set "URL2=https://nodejs.org/dist/%NODEVER%/node-%NODEVER%-win-%ARCH%.zip"

echo.
echo   [1/3] Downloading portable Node.js %NODEVER% (%ARCH%), about 33 MB ...
echo         %URL1%
echo.

if exist "%SystemRoot%\System32\curl.exe" goto :curl1
goto :ps1

:curl1
"%SystemRoot%\System32\curl.exe" -L --fail --connect-timeout 20 -o "%TMPZIP%" "%URL1%"
if not errorlevel 1 goto :got

:ps1
echo   [i] retrying with PowerShell ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing -Uri '%URL1%' -OutFile '%TMPZIP%' } catch { exit 1 }"
if not errorlevel 1 goto :got

echo.
echo   [i] mirror unavailable, trying the official site ...
if exist "%SystemRoot%\System32\curl.exe" goto :curl2
goto :ps2

:curl2
"%SystemRoot%\System32\curl.exe" -L --fail --connect-timeout 20 -o "%TMPZIP%" "%URL2%"
if not errorlevel 1 goto :got

:ps2
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing -Uri '%URL2%' -OutFile '%TMPZIP%' } catch { exit 1 }"
if not errorlevel 1 goto :got
goto :failed

rem --- sanity check ------------------------------------------------------------
:got
if not exist "%TMPZIP%" goto :failed
set "ZSIZE=0"
for %%A in ("%TMPZIP%") do set "ZSIZE=%%~zA"
if %ZSIZE% LSS 5000000 (
  echo   [X] Downloaded file looks too small (%ZSIZE% bytes^), probably an error page.
  goto :failed
)
echo   [i] downloaded %ZSIZE% bytes

rem --- extract -----------------------------------------------------------------
echo   [2/3] Extracting ...
if exist "%EXTRACT%" rmdir /s /q "%EXTRACT%"
mkdir "%EXTRACT%"
if exist "%SystemRoot%\System32\tar.exe" goto :tar
goto :unzip

:tar
"%SystemRoot%\System32\tar.exe" -xf "%TMPZIP%" -C "%EXTRACT%"
if not errorlevel 1 goto :move

:unzip
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Expand-Archive -Force -LiteralPath '%TMPZIP%' -DestinationPath '%EXTRACT%' } catch { exit 1 }"
if errorlevel 1 goto :failed

:move
if not exist "%RUNTIME%" mkdir "%RUNTIME%"
if exist "%NODEDIR%" rmdir /s /q "%NODEDIR%"
for /d %%D in ("%EXTRACT%\*") do move "%%D" "%NODEDIR%" >nul

rem --- verify ------------------------------------------------------------------
echo   [3/3] Verifying ...
if exist "%NODEDIR%\node.exe" goto :ok
echo   [X] Extraction finished but node.exe is missing. Nothing was changed elsewhere.
goto :failed

:ok
del "%TMPZIP%" >nul 2>nul
rmdir /s /q "%EXTRACT%" >nul 2>nul
echo.
echo   [OK] Portable Node.js is ready:
echo        %NODEDIR%\node.exe
"%NODEDIR%\node.exe" -v
exit /b 0

:failed
echo.
echo   [X] Could not download Node.js automatically.
echo       Please install Node.js 18 or newer from https://nodejs.org/ and retry.
exit /b 1
