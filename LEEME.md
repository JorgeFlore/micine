# Mi Cine — reproductor web para tus películas en Google Drive

## 1. Crear la credencial de Google (una sola vez, gratis)
1. Entra a https://console.cloud.google.com y crea un proyecto llamado "Mi Cine".
2. Ve a **APIs y servicios → Biblioteca**, busca **Google Drive API** y actívala.
3. Ve a **Pantalla de consentimiento de OAuth** (Google Auth Platform): tipo **Externo**, nombre "Mi Cine" y tu correo. En **Público** o **Usuarios de prueba**, agrega tu correo de Google.
4. En **Credenciales → Crear credenciales → ID de cliente de OAuth**, elige el tipo **Aplicación web**.
   - En **Orígenes de JavaScript autorizados** agrega `https://TU_USUARIO.github.io`.
5. Copia el **ID de cliente** (termina en `.apps.googleusercontent.com`) y pégalo en `index.html`, en `CLIENT_ID`.

## 2. Publicar la página (GitHub Pages, gratis)
1. Crea en GitHub un repositorio llamado `micine`.
2. Sube `index.html` y `sw.js`.
3. Ve a **Settings → Pages → Source: Deploy from a branch → main / (root)** y guarda.
4. Al minuto queda en `https://TU_USUARIO.github.io/micine/`.

## 3. Usarla
- Ábrela desde cualquier dispositivo, inicia sesión con Google y escribe el nombre de tu carpeta de películas en Drive (o pega su enlace).
- Como la app está en modo "prueba", Google muestra el aviso "Google no verificó esta app". Toca **Continuar**: la app es tuya y solo lee tu Drive.

## Modos de reproducción
- **Directo:** calidad original, subtítulos .srt automáticos y opción de seguir viendo donde quedaste. Funciona con MP4 y WebM (y con MKV en H.264 en Chrome o Edge).
- **Reproductor de Drive:** Google convierte el video y lo reproduce en cualquier formato (MKV, AVI…) hasta 1080p. Se activa solo si el modo directo falla.

## Subtítulos
Pon el `.srt` en la misma carpeta que la película y con el mismo nombre de archivo, por ejemplo `Matrix (1999).mkv` + `Matrix (1999).es.srt`.
