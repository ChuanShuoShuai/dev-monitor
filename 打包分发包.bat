@echo off
rem Build a distributable zip under dist\
rem Thin ASCII wrapper around bin\make-dist.bat
call "%~dp0bin\make-dist.bat" %*
