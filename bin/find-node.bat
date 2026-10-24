@echo off
rem ============================================================================
rem  Locate a usable Node.js runtime and put its absolute path into NODE_EXE.
rem
rem  Call with:  call "%~dp0find-node.bat"
rem  Exit code : 0 = found, 1 = not found
rem
rem  IMPORTANT: keep this file ASCII-only. A .bat containing non-ASCII text may
rem  be parsed with the OEM code page and garbled on some Windows setups.
rem  NOTE: do NOT put "setlocal" here - NODE_EXE must survive into the caller.
rem ============================================================================

set "NODE_EXE="

rem --- 1) portable runtime shipped next to this project (downloaded on demand)
if exist "%~dp0..\runtime\node\node.exe" set "NODE_EXE=%~dp0..\runtime\node\node.exe"
if defined NODE_EXE goto :found

rem --- 2) whatever is first on PATH
for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_EXE=%%~$PATH:I"
if defined NODE_EXE goto :found

rem --- 3) standard install locations
rem  NOTE: these are flat "if" lines on purpose. %ProgramFiles(x86)% expands to a
rem  string containing ")", which breaks cmd when used inside a ( ) block.
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if defined NODE_EXE goto :found
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if defined NODE_EXE goto :found
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODE_EXE goto :found
if exist "%APPDATA%\nvm\current\node.exe" set "NODE_EXE=%APPDATA%\nvm\current\node.exe"
if defined NODE_EXE goto :found

rem --- 4) WorkBuddy managed runtime (used when running inside this workspace)
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if defined NODE_EXE goto :found

exit /b 1

:found
for %%I in ("%NODE_EXE%") do set "NODE_EXE=%%~fI"
exit /b 0
