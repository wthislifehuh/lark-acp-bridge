@echo off
call "%~dp0_prepare.bat"
if errorlevel 1 exit /b 1

where kiro-cli >nul 2>nul
if errorlevel 1 (
  echo [lark-acp] warning: `kiro-cli` was not found on PATH.
  echo [lark-acp] install it from https://kiro.dev/docs/cli/installation/ and run `kiro-cli` once to log in.
)

echo [lark-acp] starting bridge with agent: kiro
node dist\bin\lark-acp.js proxy --agent kiro
pause
