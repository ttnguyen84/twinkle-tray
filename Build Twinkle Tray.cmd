@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build.ps1" -OpenOutput
set "buildExit=%errorlevel%"
if not "%buildExit%"=="0" (
    echo.
    echo Build failed. Review the output above.
    pause
)
endlocal & exit /b %buildExit%
