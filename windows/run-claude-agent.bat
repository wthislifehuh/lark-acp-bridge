@echo off
call "%~dp0_prepare.bat"
if errorlevel 1 exit /b 1

if "%ANTHROPIC_API_KEY%"=="" (
  echo [lark-acp] warning: ANTHROPIC_API_KEY is not set in this shell.
  echo [lark-acp] set it in config.json under agents.claude-agent.env, or `set ANTHROPIC_API_KEY=...` before running this.
)

echo [lark-acp] starting bridge with agent: claude-agent
node dist\bin\lark-acp.js proxy --agent claude-agent
pause
