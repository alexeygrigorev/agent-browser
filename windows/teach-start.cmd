@echo off
rem Teach recording: start. Records Chrome actions, screenshots and the microphone
rem until teach-stop.cmd runs. Bundles land in %USERPROFILE%\teach-recordings.
cd /d "%~dp0.."
set "TEACH_NAME="
set /p "TEACH_NAME=Name for this recording (Enter to skip): "
if defined TEACH_NAME (node bin\cli.js teach start --name "%TEACH_NAME%") else (node bin\cli.js teach start)
echo.
echo Work in Chrome and talk. Double-click "Teach - Stop recording" when done.
pause
