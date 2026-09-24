@echo off
rem jarvis/launch-jarvis.cmd — one-click start for Jarvis Jobs.
rem
rem Target of the desktop shortcut (created by jarvis/install-shortcut.ps1).
rem Starts the dashboard server and opens the browser. If a server is already
rem listening on the port it just opens the tab instead of failing to bind —
rem double-clicking the icon twice should never break anything.

title Jarvis Jobs
cd /d "%~dp0.."

if "%JARVIS_PORT%"=="" set JARVIS_PORT=4300

netstat -ano | findstr /R /C:":%JARVIS_PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 goto already_running

echo.
echo   Starting Jarvis Jobs on port %JARVIS_PORT%...
echo   (Close this window or press Ctrl-C to stop the server.)
echo.

rem Open the browser once the server has had a moment to bind. Detached so it
rem does not block the server process that follows.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:%JARVIS_PORT%'"

node jarvis\serve.mjs --port %JARVIS_PORT%

rem Only reached if the server exits on its own — hold the window so any error
rem stays readable instead of vanishing with the console.
echo.
echo   Server stopped.
pause
goto :eof

:already_running
echo.
echo   Jarvis Jobs is already running on port %JARVIS_PORT% — opening it.
start "" "http://localhost:%JARVIS_PORT%"
rem Full path: a bare "timeout" resolves to the GNU tool when Git/MSYS is
rem earlier on PATH, which takes different flags and errors out.
"%SystemRoot%\System32\timeout.exe" /t 2 >nul
