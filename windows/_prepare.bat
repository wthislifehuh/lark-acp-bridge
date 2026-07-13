@echo off
rem Shared setup used by every run-*.bat in this folder via `call`.
rem Deliberately has no `setlocal` - its `cd` and errorlevel must be visible
rem to the caller after `call` returns.

cd /d "%~dp0.."

if not exist "dist\bin\lark-acp.js" (
  echo [lark-acp] dist not found, building first - this can take a minute...
  call npm run build
  if errorlevel 1 (
    echo [lark-acp] Build failed - see errors above.
    pause
    exit /b 1
  )
)
