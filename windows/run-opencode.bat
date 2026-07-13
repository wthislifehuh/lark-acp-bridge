@echo off
call "%~dp0_prepare.bat"
if errorlevel 1 exit /b 1

where opencode >nul 2>nul
if errorlevel 1 (
  echo [lark-acp] warning: `opencode` was not found on PATH.
)

echo [lark-acp] starting bridge with agent: opencode
node dist\bin\lark-acp.js proxy --agent opencode
pause
