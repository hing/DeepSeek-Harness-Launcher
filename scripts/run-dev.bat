@echo off
setlocal
set ELECTRON_ENABLE_LOGGING=1
set "ROOT=%~dp0.."
"%ROOT%\build\node\node.exe" "%ROOT%\app\node_modules\electron\cli.js" "%ROOT%\app" --remote-debugging-port=9231 --no-sandbox > "%ROOT%\build\run-out.log" 2>&1
