@echo off
rem Teach recording: start (Ctrl+Alt+F9). Records the screen, microphone, mouse,
rem keyboard and windows, plus page details from Chrome, until teach-stop.cmd runs.
rem Bundles land in %USERPROFILE%\teach-recordings.
cd /d "%~dp0.."
set "TEACH_NAME="
set /p "TEACH_NAME=Name for this recording (Enter to skip): "
if defined TEACH_NAME (node bin\cli.js teach start --name "%TEACH_NAME%") else (node bin\cli.js teach start)
echo.
echo Do the task and talk. Press Ctrl+Alt+F10 or double-click "Teach - Stop recording" when done.
pause
