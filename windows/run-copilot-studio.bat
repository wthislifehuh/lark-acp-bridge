@echo off
rem Microsoft Copilot Studio agent via the bundled Direct-to-Engine adapter.
rem One-time setup first (see README.md > "Connecting Microsoft Copilot Studio"):
rem   1) register an Entra app + CopilotStudio.Copilots.Invoke permission
rem   2) put COPILOT_STUDIO_* under agents.copilot-studio.env in config.json
rem   3) run the device-code login once, e.g. in PowerShell:
rem      $env:COPILOT_STUDIO_TENANT_ID="..."; $env:COPILOT_STUDIO_APP_CLIENT_ID="..."; lark-acp-copilot-studio login

call "%~dp0_prepare.bat"
if errorlevel 1 exit /b 1

echo [lark-acp] starting bridge with agent: copilot-studio
node dist\bin\lark-acp.js proxy --agent copilot-studio
pause
