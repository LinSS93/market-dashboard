@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "DASHBOARD_URL=http://127.0.0.1:8080"
set "NODE_MAJOR="
set "NODE_MINOR="

where node >nul 2>&1
if errorlevel 1 goto :missing_node

for /f "tokens=1,2 delims=." %%A in ('node -p "process.versions.node"') do call :set_node_version %%A %%B
if not "%NODE_MAJOR%"=="26" goto :unsupported_node
if %NODE_MINOR% LSS 3 goto :unsupported_node

call :health_check
if not errorlevel 1 goto :open_existing

if not exist "node_modules\better-sqlite3\package.json" goto :install_dependencies
goto :start_server

:install_dependencies
echo.
echo [Market Dashboard] First run: installing local dependencies. Internet access is needed once.
call npm ci
if errorlevel 1 goto :install_failed

:start_server
echo.
echo [Market Dashboard] Starting a local server in a separate window...
start "Market Dashboard Local Server" cmd.exe /d /k "npm start"

set /a WAIT_SECONDS=0
:wait_for_server
call :health_check
if not errorlevel 1 goto :open_new
set /a WAIT_SECONDS+=1
if %WAIT_SECONDS% GEQ 15 goto :server_timeout
powershell.exe -NoProfile -Command "Start-Sleep -Seconds 1"
goto :wait_for_server

:open_new
echo [Market Dashboard] Ready. Opening %DASHBOARD_URL%
if /I not "%MARKET_DASHBOARD_NO_BROWSER%"=="1" start "" "%DASHBOARD_URL%"
goto :done

:open_existing
echo [Market Dashboard] A local server is already running. Opening %DASHBOARD_URL%
if /I not "%MARKET_DASHBOARD_NO_BROWSER%"=="1" start "" "%DASHBOARD_URL%"
goto :done

:missing_node
echo.
echo [Market Dashboard] Node.js 26.3.x is required but was not found.
echo Install Node.js from https://nodejs.org/ , then run this file again.
goto :failed

:unsupported_node
echo.
echo [Market Dashboard] This release requires Node.js 26.3.x. Current version:
node --version
goto :failed

:install_failed
echo.
echo [Market Dashboard] Dependency installation failed.
echo Read docs\windows-quick-start.md for help.
goto :failed

:server_timeout
echo.
echo [Market Dashboard] The server did not become ready within 15 seconds.
echo Check the "Market Dashboard Local Server" window for the error details.
goto :failed

:set_node_version
set "NODE_MAJOR=%~1"
set "NODE_MINOR=%~2"
exit /b 0

:health_check
powershell.exe -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%DASHBOARD_URL%/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } } catch {} ; exit 1"
exit /b %ERRORLEVEL%

:failed
echo.
pause
exit /b 1

:done
echo.
echo Keep the "Market Dashboard Local Server" window open while using the dashboard.
exit /b 0
