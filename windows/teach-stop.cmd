@echo off
rem Teach recording: stop (Ctrl+Alt+F10), transcribe, build timeline.md and copy the bundle to Hetzner.
cd /d "%~dp0.."
node bin\cli.js teach stop
echo.
pause
