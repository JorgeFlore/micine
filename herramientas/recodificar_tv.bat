@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
REM ==========================================================
REM  Mi Cine - RECODIFICA películas para que se vean en CUALQUIER TV
REM  Úsalo solo con las que no se ven en alguna TV (ej. Xiaomi).
REM  - Video: se vuelve a codificar a H.264 High 4.1, 8 bits (el formato más compatible)
REM    usando la tarjeta NVIDIA (rápido). Si no hay NVIDIA, usa el procesador (más lento).
REM  - Audio: AAC-LC estéreo 48 kHz
REM  - Índice al inicio (faststart)
REM  Uso: arrastra una o varias películas sobre este archivo,
REM       o déjalo en la carpeta de las películas y haz doble clic (las hace todas).
REM  Resultado: carpeta "para_tv" junto a las películas.
REM  Requiere ffmpeg:  winget install Gyan.FFmpeg
REM ==========================================================

where ffmpeg >nul 2>&1 || (
  echo No encontré ffmpeg. Instálalo con:  winget install Gyan.FFmpeg
  echo Luego cierra y vuelve a abrir esta ventana.
  pause & exit /b
)

REM ¿Hay NVIDIA disponible?
set "VCODEC=libx264 -preset medium -crf 20"
ffmpeg -hide_banner -loglevel error -f lavfi -i color=black:s=256x144:d=0.1 -c:v h264_nvenc -f null - >nul 2>&1 && set "VCODEC=h264_nvenc -preset p5 -rc vbr -cq 21 -b:v 0"
echo Codificador de video: %VCODEC%
echo.

if "%~1"=="" (
  for %%F in (*.mkv *.mp4 *.avi *.mov *.m4v) do call :convertir "%%~fF"
) else (
  for %%F in (%*) do call :convertir "%%~fF"
)
echo.
echo Listo. Sube a Drive lo que quedó en la carpeta "para_tv" (reemplazando la versión anterior).
pause
exit /b

:convertir
set "ENT=%~1"
set "DIR=%~dp1para_tv"
if not exist "%DIR%" mkdir "%DIR%"
set "SAL=%DIR%\%~n1.mp4"
if exist "%SAL%" ( echo [ya existe] %~n1 & exit /b )
echo === Recodificando: %~nx1 ===
ffmpeg -hide_banner -loglevel error -stats -i "%ENT%" ^
  -map 0:v:0 -map 0:a:0? -c:v %VCODEC% -profile:v high -level:v 4.1 -pix_fmt yuv420p ^
  -g 48 -bf 2 -c:a aac -b:a 192k -ac 2 -ar 48000 ^
  -map_metadata -1 -movflags +faststart "%SAL%"
if errorlevel 1 ( echo   ! Error con %~nx1 & del "%SAL%" 2>nul )
exit /b
