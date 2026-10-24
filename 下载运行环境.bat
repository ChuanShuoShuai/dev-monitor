@echo off
rem Download a portable Node.js runtime into runtime\node
rem Thin ASCII wrapper around bin\get-node.bat
call "%~dp0bin\get-node.bat" %*
echo.
pause
