@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>nul
title Engineering Monitor

rem ============================================================================
rem  One-click launcher for the project monitor.
rem  Keep this file ASCII-only (see find-node.bat for why).
rem  All user-facing Chinese text is printed by Node, which is Unicode-safe.
rem ============================================================================

cd /d "%~dp0.."

call "%~dp0find-node.bat"
if not errorlevel 1 goto :run

echo.
echo   [i] Node.js was not found on this machine.
echo       Downloading a portable runtime automatically ^(one time, about 33 MB^).

call "%~dp0get-node.bat"
if errorlevel 1 goto :nonode

set "NODE_EXE="
call "%~dp0find-node.bat"
if errorlevel 1 goto :nonode

:run
"%NODE_EXE%" "%~dp0launcher.js" %*
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :end

echo.
echo   [!] Monitor exited with code %RC%.
pause

:end
endlocal
exit /b 0

:nonode
echo.
echo   [X] Node.js could not be set up automatically.
echo       Install Node.js 18+ from https://nodejs.org/ and run this file again.
echo.
pause
endlocal
exit /b 1
