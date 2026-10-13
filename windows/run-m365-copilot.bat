@echo off
rem Microsoft 365 Copilot (BizChat) via the bundled Graph Chat API adapter.
rem NOTE: the Chat API is a preview, delegated-auth-only API and each signed-in
rem user needs a Microsoft 365 Copilot license (see README.md >
rem "Connecting Microsoft 365 Copilot"). One-time setup first:
rem   1) register an Entra app + the 7 delegated Graph scopes (admin consent)
rem   2) put M365_COPILOT_* under agents.m365-copilot.env in config.json
rem   3) run the device-code login once, e.g. in PowerShell:
rem      $env:M365_COPILOT_TENANT_ID="..."; $env:M365_COPILOT_APP_CLIENT_ID="..."; lark-acp-m365 login

call "%~dp0_prepare.bat"
if errorlevel 1 exit /b 1

echo [lark-acp] starting bridge with agent: m365-copilot
node dist\bin\lark-acp.js proxy --agent m365-copilot
pause
