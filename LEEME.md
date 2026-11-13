# Mi Cine — películas en Google Drive, con usuarios propios

Página: https://jorgeflore.github.io/micine/

## Cómo funciona
- Las películas viven en la carpeta `Peliculas` de tu Google Drive.
- Una **cuenta de servicio** de Google (un "robot") tiene acceso de solo lectura a esa carpeta, y a nada más.
- El **Worker de Cloudflare** (`worker/worker.js`) revisa usuario y contraseña y entrega permisos de 1 hora para leer la carpeta.
- El video se transmite directo desde Google al navegador.

## Administrar usuarios
En Cloudflare → tu Worker `micine` → Settings → Variables and Secrets → edita `USERS`:
```json
{"jorge":"clave-jorge","mama":"clave-mama","pareja":"clave-pareja"}
```
Los nombres de usuario van en minúsculas. Si borras a alguien de la lista, pierde el acceso de inmediato.

## Configuración inicial (una sola vez)
1. **Cuenta de servicio:** en Google Cloud Console → IAM y administración → Cuentas de servicio → Crear. Nómbrala `micine-lector` y no le asignes roles. Luego entra a ella → Claves → Agregar clave → JSON, y se descarga el archivo.
2. **Compartir la carpeta:** en Drive, comparte `Peliculas` con el correo de la cuenta de servicio (`...@...iam.gserviceaccount.com`) como **Lector**.
3. **Worker:** en dash.cloudflare.com → Workers & Pages → Create → Hello World. Nómbralo `micine`, presiona Deploy, después Edit code, pega `worker/worker.js` y vuelve a presionar Deploy.
4. **Secretos del Worker** (Settings → Variables and Secrets, tipo *Secret*):
   - `SA_JSON`: el contenido completo del .json descargado.
   - `FOLDER_ID`: el ID de la carpeta (la última parte de su URL en Drive).
   - `USERS`: la lista de usuarios (ver arriba).
   - `SESSION_SECRET`: cualquier texto largo y aleatorio.
5. Pega la URL del Worker en `index.html`, en `WORKER_URL`.

## Carátulas
- Automáticas desde TMDB: agrega el secreto `TMDB_KEY` en el Worker (token de lectura de themoviedb.org → Ajustes → API).
- Para el mejor resultado, nombra el archivo `Titulo (Año).mp4`.
- Carátula propia: pon una imagen con el mismo nombre que la película (`Pelicula.jpg`), o `poster.jpg` en la carpeta de la película. Tiene prioridad sobre TMDB.

## Formatos
Funcionan **MP4 (H.264 + AAC)** y WebM en todos los dispositivos. Los MKV hay que convertirlos a MP4.
Subtítulos: un `.srt` con el mismo nombre que la película, por ejemplo `Pelicula.mp4` + `Pelicula.es.srt`.
