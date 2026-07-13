@echo off
call "%~dp0_prepare.bat"
if errorlevel 1 exit /b 1

echo [lark-acp] starting bridge with agent: claude
node dist\bin\lark-acp.js proxy --agent claude
pause
