@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>nul
title Build distributable package

rem  Package the monitor into dist\*.zip. Keep this file ASCII-only.

cd /d "%~dp0.."

call "%~dp0find-node.bat"
if not errorlevel 1 goto :run

echo.
echo   [i] Node.js was not found. Downloading a portable runtime first ...
call "%~dp0get-node.bat"
if errorlevel 1 goto :nonode

set "NODE_EXE="
call "%~dp0find-node.bat"
if errorlevel 1 goto :nonode

:run
"%NODE_EXE%" "%~dp0make-dist.js" %*
echo.
pause
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
