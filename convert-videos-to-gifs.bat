@echo off
echo Converting Cypress test videos to GIFs...
echo ============================================

cd cypress\videos

for %%f in (*.mp4) do (
    echo Converting %%f...
    ffmpeg -i "%%f" -vf "fps=10,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 "%%~nf.gif" -y
    if !errorlevel! equ 0 (
        echo   ✓ %%~nf.gif created
    ) else (
        echo   ✗ Failed to convert %%f
    )
)

echo.
echo ============================================
echo Conversion complete!
echo GIF files are in: cypress\videos\
echo.
pause
