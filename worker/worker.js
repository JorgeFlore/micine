// Mi Cine — servidor de acceso (Cloudflare Worker)
// Valida usuarios propios y entrega permisos temporales de SOLO LECTURA
// a la carpeta de películas, usando una cuenta de servicio de Google.
//
// Variables (Settings → Variables and Secrets), todas como "Secret":
//   SA_JSON         contenido completo del archivo .json de la cuenta de servicio
//   FOLDER_ID       ID de la carpeta "Peliculas" de Drive
//   USERS           {"jorge":"clave1","mama":"clave2"}  (usuario en minúsculas)
//   SESSION_SECRET  texto largo y aleatorio (firma las sesiones)
//   TMDB_KEY        (opcional) clave API o token de lectura de themoviedb.org, para carátulas
// Bindings (Settings → Bindings):
//   DB              (opcional) base de datos D1 para sincronizar "Seguir viendo" entre dispositivos

const ALLOWED_ORIGINS = ["https://jorgeflore.github.io", "http://localhost:8000"];
const SESSION_DAYS = 30;
let cached = null; // token de Google en caché

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
      "Vary": "Origin",
    };
    const json = (o, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

    const url = new URL(req.url);
    const { pathname } = url;
    if (req.method === "OPTIONS") {
      if (pathname.startsWith("/cast")) return new Response(null, { headers: {
        "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Range",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" } });
      return new Response(null, { headers: cors });
    }

    try {
      const users = JSON.parse(env.USERS);

      if (pathname === "/login" && req.method === "POST") {
        const { user, pass } = await req.json();
        const u = String(user || "").trim().toLowerCase();
        const ok = Object.hasOwn(users, u) && (await safeEqual(String(users[u]), String(pass || "")));
        if (!ok) {
          await new Promise(r => setTimeout(r, 800)); // frena intentos por fuerza bruta
          return json({ error: "Usuario o contraseña incorrectos" }, 401);
        }
        const session = await signSession({ u, exp: Date.now() + SESSION_DAYS * 864e5 }, env.SESSION_SECRET);
        return json({ session, user: u });
      }

      const s = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
      const data = await verifySession(s, env.SESSION_SECRET);
      // Si borras a alguien de USERS, pierde el acceso de inmediato.
      const authed = data && Object.hasOwn(users, data.u);

      if (pathname === "/meta") {
        if (!authed) return json({ error: "Sesión inválida" }, 401);
        if (!env.TMDB_KEY) return json({ error: "Falta TMDB_KEY" }, 501);
        const q = url.searchParams.get("q") || "", y = url.searchParams.get("y") || "";
        const cacheKey = new Request("https://micine-cache/meta?q=" + encodeURIComponent(q) + "&y=" + y);
        const hit = await caches.default.match(cacheKey);
        if (hit) return new Response(hit.body, { headers: { ...cors, "Content-Type": "application/json" } });
        const meta = await tmdb(q, y, env.TMDB_KEY);
        const res = new Response(JSON.stringify(meta), {
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=2592000" },
        });
        await caches.default.put(cacheKey, res.clone());
        return new Response(res.body, { headers: { ...cors, "Content-Type": "application/json" } });
      }

      /* ----- Avance sincronizado (D1) ----- */
      if (pathname === "/progress") {
        if (!authed) return json({ error: "Sesión inválida" }, 401);
        const db = await progressDb(env);
        if (!db) return json({ error: "Falta la base de datos DB" }, 501);
        if (req.method === "POST") {
          const items = [].concat(await req.json()).slice(0, 50);
          await db.batch(items.map(it => db.prepare(
            `INSERT INTO progress (user, id, pos, done, t) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(user, id) DO UPDATE SET pos = excluded.pos, done = excluded.done, t = excluded.t
             WHERE excluded.t >= progress.t`
          ).bind(data.u, String(it.id), Math.max(0, Math.floor(+it.p || 0)), it.d ? 1 : 0, Math.floor(+it.t || Date.now()))));
          return json({ ok: true });
        }
        const { results } = await db.prepare("SELECT id, pos, done, t FROM progress WHERE user = ?1").bind(data.u).all();
        return json(results.map(r => ({ id: r.id, p: r.pos, d: !!r.done, t: r.t })));
      }

      /* ----- Chromecast: enlaces firmados que la TV puede abrir sin sesión ----- */
      if (pathname === "/castlink") {
        if (!authed) return json({ error: "Sesión inválida" }, 401);
        const id = url.searchParams.get("id") || "";
        const subs = (url.searchParams.get("subs") || "").split(",").filter(Boolean);
        if (!/^[\w-]+$/.test(id) || !subs.every(x => /^[\w-]+$/.test(x))) return json({ error: "ID inválido" }, 400);
        const t = await signSession({ u: data.u, c: [id, ...subs], exp: Date.now() + 8 * 3600e3 }, env.SESSION_SECRET);
        const base = url.origin;
        return json({
          video: `${base}/cast/${id}?t=${t}`,
          subs: subs.map(s => `${base}/castsub/${s}.vtt?t=${t}`),
        });
      }
      const castMatch = pathname.match(/^\/(cast|castsub)\/([\w-]+?)(\.vtt)?$/);
      if (castMatch) {
        const [, kind, id] = castMatch;
        const open = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges" };
        const ct = await verifySession(url.searchParams.get("t") || "", env.SESSION_SECRET);
        if (!ct || !Array.isArray(ct.c) || !ct.c.includes(id) || !Object.hasOwn(users, ct.u))
          return new Response("Enlace vencido", { status: 403, headers: open });
        const g = await googleToken(env);
        const headers = { Authorization: "Bearer " + g.token };
        const range = req.headers.get("Range");
        if (range && kind === "cast") headers.Range = range;
        const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers });
        if (!r.ok) return new Response("Drive " + r.status, { status: r.status, headers: open });
        if (kind === "castsub") {
          let txt = await r.text();
          if (!txt.trimStart().startsWith("WEBVTT")) txt = srtToVtt(txt);
          return new Response(txt, { headers: { ...open, "Content-Type": "text/vtt; charset=utf-8" } });
        }
        const out = new Headers(open);
        for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]) {
          const v = r.headers.get(h); if (v) out.set(h, v);
        }
        if (!out.has("Accept-Ranges")) out.set("Accept-Ranges", "bytes");
        return new Response(req.method === "HEAD" ? null : r.body, { status: r.status, headers: out });
      }

      if (pathname === "/token") {
        if (!authed) return json({ error: "Sesión inválida" }, 401);
        const t = await googleToken(env);
        return json({
          access_token: t.token,
          expires_in: Math.floor((t.exp - Date.now()) / 1000),
          folder: env.FOLDER_ID,
          user: data.u,
        });
      }

      return json({ error: "No encontrado" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

/* ---------- Base de datos del avance ---------- */
let dbReady = false;
async function progressDb(env) {
  if (!env.DB) return null;
  if (!dbReady) {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS progress (
         user TEXT NOT NULL, id TEXT NOT NULL, pos INTEGER NOT NULL DEFAULT 0,
         done INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL, PRIMARY KEY (user, id))`
    ).run();
    dbReady = true;
  }
  return env.DB;
}
function srtToVtt(s) {
  return "WEBVTT\n\n" + s.replace(/\r/g, "").replace(/^\uFEFF/, "")
    .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2").replace(/^\d+\n(?=\d\d:)/gm, "");
}

/* ---------- Carátulas y sinopsis desde TMDB ---------- */
async function tmdb(q, y, key) {
  const isToken = key.startsWith("eyJ"); // token de lectura v4 o clave v3
  const search = async (lang, year) => {
    const p = new URLSearchParams({ query: q, language: lang, include_adult: "false" });
    if (year) p.set("year", year);
    if (!isToken) p.set("api_key", key);
    const r = await fetch("https://api.themoviedb.org/3/search/movie?" + p,
      { headers: isToken ? { Authorization: "Bearer " + key } : {} });
    if (!r.ok) throw new Error("TMDB " + r.status);
    return (await r.json()).results || [];
  };
  let res = await search("es-MX", y);
  if (!res.length && y) res = await search("es-MX", "");
  const m = res.find(x => x.poster_path) || res[0];
  if (!m) return { found: false };
  let overview = m.overview;
  if (!overview) overview = ((await search("en-US", y)).find(x => x.id === m.id) || {}).overview || "";
  return {
    found: true,
    title: m.title,
    year: (m.release_date || "").slice(0, 4),
    overview,
    poster: m.poster_path ? "https://image.tmdb.org/t/p/w342" + m.poster_path : null,
    rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
  };
}

/* ---------- Token de Google con la cuenta de servicio ---------- */
async function googleToken(env) {
  if (cached && cached.exp - Date.now() > 5 * 60e3) return cached;
  const sa = JSON.parse(env.SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned =
    enc({ alg: "RS256", typ: "JWT" }) + "." +
    enc({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: unsigned + "." + b64url(new Uint8Array(sig)),
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Google: " + (j.error_description || j.error || r.status));
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached;
}

/* ---------- Sesiones firmadas (HMAC) ---------- */
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signSession(data, secret) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(data)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body));
  return body + "." + b64url(new Uint8Array(sig));
}
async function verifySession(token, secret) {
  const [body, sig] = String(token).split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64url(sig), new TextEncoder().encode(body));
  if (!ok) return null;
  const data = JSON.parse(new TextDecoder().decode(unb64url(body)));
  return data.exp > Date.now() ? data : null;
}

/* ---------- Utilidades ---------- */
async function safeEqual(a, b) {
  const h = async s => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([h(a), h(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
}
