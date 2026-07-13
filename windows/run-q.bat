@echo off
rem Amazon Q has no native Windows build - `q` itself only runs under WSL/Linux/macOS.
rem This launcher builds on the Windows side (dist/ is plain JS, safe to share),
rem then hands off to a Node process running *inside* WSL to spawn `q`.
rem See README.md > "Connecting Amazon Q" for one-time setup (installing `q`,
rem `q login`, and why `bash -lc` below matters for PATH).

call "%~dp0_prepare.bat"
if errorlevel 1 exit /b 1

where wsl >nul 2>nul
if errorlevel 1 (
  echo [lark-acp] `wsl` was not found. Install WSL first: https://learn.microsoft.com/windows/wsl/install
  pause
  exit /b 1
)

for /f "usebackq delims=" %%i in (`wsl wslpath -a "%cd%"`) do set "WSL_REPO_PATH=%%i"
if "%WSL_REPO_PATH%"=="" (
  echo [lark-acp] could not resolve this folder as a WSL path. Is your default WSL distro installed and working? Try `wsl` on its own first.
  pause
  exit /b 1
)

echo [lark-acp] starting bridge with agent: q ^(inside WSL at %WSL_REPO_PATH%^)
wsl.exe -- bash -lc "cd '%WSL_REPO_PATH%' && node dist/bin/lark-acp.js proxy --agent q"
pause
