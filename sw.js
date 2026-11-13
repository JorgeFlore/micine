// Service worker de Mi Cine: transmite los videos desde Google Drive
// agregando el token de acceso, con soporte para adelantar/retroceder (Range).
let token = null;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("message", e => {
  if (e.data && e.data.type === "token") token = e.data.token;
});

// Si el navegador reinició el service worker, le pide el token a la página abierta.
async function getToken() {
  if (token) return token;
  const list = await self.clients.matchAll({ type: "window" });
  for (const c of list) {
    const t = await new Promise(res => {
      const ch = new MessageChannel();
      ch.port1.onmessage = e => res(e.data);
      c.postMessage({ type: "needToken" }, [ch.port2]);
      setTimeout(() => res(null), 3000);
    });
    if (t) { token = t; return t; }
  }
  return null;
}

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  const m = url.origin === self.location.origin && url.pathname.match(/\/stream\/([\w-]+)$/);
  if (!m) return;
  event.respondWith((async () => {
    const t = await getToken();
    if (!t) return new Response("Sin sesión", { status: 401 });
    const headers = { Authorization: "Bearer " + t };
    const range = event.request.headers.get("Range");
    if (range) headers.Range = range;
    const r = await fetch(
      "https://www.googleapis.com/drive/v3/files/" + m[1] + "?alt=media&supportsAllDrives=true",
      { headers }
    );
    if (r.status === 401) token = null;
    return r;
  })());
});
