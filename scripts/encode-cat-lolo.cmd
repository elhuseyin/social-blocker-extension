@echo off
setlocal
cd /d "%~dp0.."

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [encode-cat-lolo] ffmpeg not found. Install from https://ffmpeg.org/download.html and add to PATH.
  exit /b 1
)

if not exist "assets\cat_lolo.mov" (
  echo [encode-cat-lolo] assets\cat_lolo.mov not found. Place your source clip there, or put a ready-made cat_lolo.mp4 in assets\.
  exit /b 1
)

echo [encode-cat-lolo] Writing assets\cat_lolo.mp4 ^(H.264, yuv420p, faststart, no audio^)...
ffmpeg -y -i "assets\cat_lolo.mov" -c:v libx264 -profile:v main -pix_fmt yuv420p -movflags +faststart -an "assets\cat_lolo.mp4"
if errorlevel 1 (
  echo [encode-cat-lolo] ffmpeg failed.
  exit /b 1
)

echo [encode-cat-lolo] Done. Reload the extension in chrome://extensions
