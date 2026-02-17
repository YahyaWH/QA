@echo off
setlocal enabledelayedexpansion
echo Converting Cypress test videos to Enhanced GIFs...
echo ================================================

cd cypress\videos

for %%f in (*-PASSED.mp4 *-FAILED.mp4) do (
    set "filename=%%~nf"
    
    REM Extract test ID and status
    for /f "tokens=1,2,3 delims=-" %%a in ("!filename!") do (
        set "testid=%%a-%%b-%%c"
        set "status=UNKNOWN"
    )
    
    REM Determine status and color
    echo !filename! | findstr "PASSED" >nul
    if !errorlevel! equ 0 (
        set "status=PASSED"
        set "color=green"
    )
    
    echo !filename! | findstr "FAILED" >nul
    if !errorlevel! equ 0 (
        set "status=FAILED"
        set "color=red"
    )
    
    echo Converting %%f with overlays...
    
    REM Convert with slower speed (fps=8) and text overlays
    ffmpeg -i "%%f" -vf "setpts=1.5*PTS,fps=8,scale=800:-1:flags=lanczos,drawtext=text='Test: !testid!':fontsize=24:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=5:x=10:y=10,drawtext=text='Status\: !status!':fontsize=32:fontcolor=!color!:box=1:boxcolor=black@0.8:boxborderw=5:x=10:y=50,drawtext=text='%%{pts\:hms}':fontsize=20:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=5:x=(w-text_w-10):y=10,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 "!filename!.gif" -y
    
    if !errorlevel! equ 0 (
        echo   ✓ !filename!.gif created with overlays
    ) else (
        echo   ✗ Failed to convert %%f
    )
    echo.
)

echo ================================================
echo Conversion complete!
echo Enhanced GIF files are in: cypress\videos\
echo.
echo Features:
echo - 1.5x slower playback for better visibility
echo - Test ID overlay (top-left)
echo - Status badge (PASSED=green, FAILED=red)
echo - Timestamp (top-right)
echo ================================================
pause
