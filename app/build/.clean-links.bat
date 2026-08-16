@echo off
chcp 65001 >nul
rem DSHL 移动目录辅助脚本（双击运行）
rem 删除 .dsh\profiles\node_modules 受管链接树，以便安全跨盘移动程序目录。
rem 该链接树不含用户数据，移动后首次启动会自动重建。
setlocal
set "LINK=%~dp0.dsh\profiles\node_modules"
if not exist "%LINK%" goto missing
rmdir /s /q "%LINK%"
if exist "%LINK%" goto fail
echo 已删除受管链接树，现在可以安全移动程序目录。
echo 移动后首次启动会自动重建全部链接。
goto done
:missing
echo 未找到受管链接树（可能尚未启动过），现在可以安全移动程序目录。
goto done
:fail
echo 删除失败：可能被程序占用，请先退出 DSHL 再运行本脚本。
:done
echo.
pause