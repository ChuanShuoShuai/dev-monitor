@echo off
rem One-click launcher. Thin ASCII wrapper around bin\start-monitor.bat
rem (the wrapper has a Chinese name only so it is obvious to double-click;
rem  its content stays ASCII because cmd may parse .bat text with the OEM code page)
call "%~dp0bin\start-monitor.bat" %*
