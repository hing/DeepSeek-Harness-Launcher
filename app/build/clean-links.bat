@echo off
rem DSHL 移动目录辅助脚本（双击运行）
rem 删除 .dsh\profiles\node_modules 受管链接树，以便安全跨盘移动程序目录。
rem 该链接树不含用户数据，移动后首次启动会自动重建。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0clean-links.ps1"
echo.
pause
