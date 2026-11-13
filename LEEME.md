# Mi Cine — películas en Google Drive, con usuarios propios

Página: https://jorgeflore.github.io/micine/

## Cómo funciona
- Las películas viven en la carpeta `Peliculas` de tu Google Drive.
- Una **cuenta de servicio** de Google (un "robot") tiene acceso de solo lectura a esa carpeta, y a nada más.
- El **Worker de Cloudflare** (`worker/worker.js`) revisa usuario y contraseña y entrega permisos de 1 hora para leer la carpeta.
- El video se transmite directo desde Google al navegador.

## Administrar usuarios
Desde la app, toca **👤 tu nombre** (arriba a la derecha) → sección **Usuarios**:
- **Agregar:** nombre + contraseña (🎲 genera una). Te muestra un mensaje listo para copiar o enviar por WhatsApp.
- **🔑 Clave:** cambia la contraseña de alguien y cierra sus sesiones abiertas.
- **Eliminar:** borra al usuario y su avance; pierde el acceso al instante.
Cada usuario puede cambiar su propia contraseña en el mismo menú.

El administrador es el primer usuario de `USERS` (o los que pongas en la variable `ADMINS`, separados por coma).
Los usuarios de `USERS` son "fijos" y solo se cambian en Cloudflare. Los demás se guardan en la base D1 (requiere el binding `DB`).

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

## "Seguir viendo" sincronizado
Cloudflare → Storage & Databases → D1 → Create, con el nombre `micine`. Luego, en el Worker, ve a Settings → Bindings → Add → D1 database, pon `DB` como nombre de variable, elige `micine` y presiona Deploy. La tabla se crea sola.

## Enviar a la TV (Chromecast)
Funciona desde Chrome en Android, PC o Mac, con la TV en la misma red Wi-Fi. En iPhone no está disponible porque Safari no soporta Cast.
En la ficha de la película aparece el botón "📺 Ver en la TV". La TV recibe un enlace firmado que vence en 8 horas.

## Carátulas
- Automáticas desde TMDB: agrega el secreto `TMDB_KEY` en el Worker (token de lectura de themoviedb.org → Ajustes → API).
- Para el mejor resultado, nombra el archivo `Titulo (Año).mp4`.
- Carátula propia: pon una imagen con el mismo nombre que la película (`Pelicula.jpg`), o `poster.jpg` en la carpeta de la película. Tiene prioridad sobre TMDB.

## Formatos
Funcionan **MP4 (H.264 + AAC)** y WebM en todos los dispositivos. Los MKV hay que convertirlos a MP4.
Subtítulos: un `.srt` con el mismo nombre que la película, por ejemplo `Pelicula.mp4` + `Pelicula.es.srt`.
