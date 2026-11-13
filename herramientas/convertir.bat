@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
REM ==========================================================
REM  Mi Cine - Convierte películas a MP4 compatible con navegador
REM  - Video: se copia sin perder calidad (no se recodifica)
REM  - Audio: todas las pistas se pasan a AAC estéreo (se escucha en Chrome/celular)
REM  - Subtítulos de texto incluidos en el MKV: se extraen a .srt
REM  Uso: copia este archivo en la carpeta de tus películas y haz doble clic.
REM  Requiere ffmpeg:  winget install Gyan.FFmpeg
REM ==========================================================

where ffmpeg >nul 2>&1 || (
  echo No encontré ffmpeg. Instálalo con:  winget install Gyan.FFmpeg
  echo Luego cierra y vuelve a abrir esta ventana.
  pause & exit /b
)

if not exist "convertidas" mkdir "convertidas"

for %%F in (*.mkv *.mp4 *.avi *.mov *.m4v) do (
  set "NOM=%%~nF"
  if exist "convertidas\!NOM!.mp4" (
    echo [ya existe] !NOM!
  ) else (
    echo.
    echo === Convirtiendo: %%F ===
    ffmpeg -hide_banner -loglevel error -stats -i "%%F" ^
      -map 0:v:0 -map 0:a? -c:v copy -c:a aac -b:a 192k -ac 2 ^
      -movflags +faststart "convertidas\!NOM!.mp4"
    if errorlevel 1 (
      echo   ! El video no se pudo copiar directo, recodificando con la GPU NVIDIA...
      ffmpeg -hide_banner -loglevel error -stats -y -i "%%F" ^
        -map 0:v:0 -map 0:a? -c:v h264_nvenc -preset p5 -cq 21 -pix_fmt yuv420p ^
        -c:a aac -b:a 192k -ac 2 -movflags +faststart "convertidas\!NOM!.mp4"
    )
    REM Extrae la primera pista de subtítulos de texto, si existe
    ffmpeg -hide_banner -loglevel quiet -y -i "%%F" -map 0:s:0 "convertidas\!NOM!.srt" 2>nul
    for %%S in ("convertidas\!NOM!.srt") do if %%~zS==0 del "%%S"
  )
)

echo.
echo Listo. Sube a Drive lo que quedó en la carpeta "convertidas".
pause
