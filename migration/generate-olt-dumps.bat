@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "BACKEND_DIR=%SCRIPT_DIR%.."

pushd "%BACKEND_DIR%" >nul
if errorlevel 1 (
  echo Failed to open backend directory: %BACKEND_DIR%
  exit /b 1
)

echo ========================================
echo Generating GPON and EPON OLT dumps
echo Backend: %CD%
echo ========================================
echo.

echo [1/2] GPON dump
node migration\dump.gpon.telnet.js
if errorlevel 1 (
  echo.
  echo GPON dump failed.
  popd >nul
  exit /b 1
)

echo.
echo [2/2] EPON dump
node migration\dump.epon-olt-telnet.js
if errorlevel 1 (
  echo.
  echo EPON dump failed.
  popd >nul
  exit /b 1
)

echo.
echo ========================================
echo OLT dump generation finished.
echo Dumps saved in migration\olt-dumps
echo ========================================

popd >nul
endlocal
