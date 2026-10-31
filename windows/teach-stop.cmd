@echo off
rem Teach recording: stop, transcribe, build timeline.md and copy the bundle to Hetzner.
cd /d "%~dp0.."
node bin\cli.js teach stop
echo.
pause
