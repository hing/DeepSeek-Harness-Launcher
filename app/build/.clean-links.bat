@echo off
rem DSHL move-directory helper (double-click to run)
rem Deletes the managed link tree .dsh\profiles\node_modules so the app folder
rem can be moved across drives safely. The tree holds NO user data and is
rem rebuilt automatically on next launch.
setlocal
set "LINK=%~dp0.dsh\profiles\node_modules"
if not exist "%LINK%" goto missing
rmdir /s /q "%LINK%"
if exist "%LINK%" goto fail
echo Managed link tree removed. You can now move the app folder safely.
echo Links will be rebuilt automatically on next launch.
goto done
:missing
echo No managed link tree found (maybe not launched yet). Safe to move now.
goto done
:fail
echo Delete failed: files may be in use. Quit DSHL first, then retry.
:done
echo.
pause