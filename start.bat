@echo off
rem Legacy entry point kept for people used to the old name.
rem Thin ASCII wrapper around bin\start-monitor.bat
call "%~dp0bin\start-monitor.bat" %*
