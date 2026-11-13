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
//   ADMINS          (opcional) administradores separados por coma; por defecto, el primer usuario de USERS
// Los usuarios de USERS son fijos. Los demás se crean desde el panel "Usuarios" de la app (se guardan en D1).
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
      "Access-Control-Allow-Methods": "GET, POST, DELETE, HEAD, OPTIONS",
      "Vary": "Origin",
    };
    const json = (o, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

    const url = new URL(req.url);
    const { pathname } = url;
    if (req.method === "OPTIONS") {
      if (/^\/(cast|castsub)\//.test(pathname)) return new Response(null, { headers: {
        "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Range",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" } });
      return new Response(null, { headers: cors });
    }

    try {
      const users = JSON.parse(env.USERS);

      if (pathname === "/login" && req.method === "POST") {
        const { user, pass } = await req.json();
        const u = String(user || "").trim().toLowerCase();
        let ok = false, v = 0;
        if (Object.hasOwn(users, u)) ok = await safeEqual(String(users[u]), String(pass || ""));
        else {
          const row = await dbUser(env, u, true);
          if (row) { ok = await safeEqual(row.hash, await hashPass(String(pass || ""), row.salt)); v = row.ver; }
        }
        if (!ok) {
          await new Promise(r => setTimeout(r, 800)); // frena intentos por fuerza bruta
          return json({ error: "Usuario o contraseña incorrectos" }, 401);
        }
        const session = await signSession({ u, v, exp: Date.now() + SESSION_DAYS * 864e5 }, env.SESSION_SECRET);
        return json({ session, user: u });
      }

      const s = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
      const data = await verifySession(s, env.SESSION_SECRET);
      // Si borras a alguien o le cambias la clave, sus sesiones dejan de valer de inmediato.
      const authed = data && await userValid(env, users, data.u, data.v);
      const admins = (env.ADMINS || Object.keys(users)[0] || "").split(",").map(x => x.trim().toLowerCase());
      const isAdmin = authed && admins.includes(data.u);

      /* ----- Panel de usuarios ----- */
      if (pathname.startsWith("/admin/users")) {
        if (!isAdmin) return json({ error: "Solo el administrador puede hacer esto" }, 403);
        const db = await appDb(env);
        if (!db) return json({ error: "Falta conectar la base de datos DB en Cloudflare" }, 501);
        const name = decodeURIComponent(pathname.split("/")[3] || "").toLowerCase();
        const action = pathname.split("/")[4] || "";
        if (req.method === "GET" && !name) {
          const { results } = await db.prepare("SELECT name, created FROM users ORDER BY name").all();
          return json([
            ...Object.keys(users).map(n => ({ name: n, fixed: true, admin: admins.includes(n) })),
            ...results.map(r => ({ name: r.name, created: r.created, fixed: false, admin: admins.includes(r.name) })),
          ]);
        }
        if (req.method === "POST" && !name) {
          const { name: nn, pass } = await req.json();
          const n = String(nn || "").trim().toLowerCase();
          if (!/^[a-z0-9._-]{2,24}$/.test(n)) return json({ error: "Nombre inválido: usa 2 a 24 letras minúsculas, números, punto, guion o guion bajo, sin espacios" }, 400);
          if (String(pass || "").length < 6) return json({ error: "La contraseña debe tener al menos 6 caracteres" }, 400);
          if (Object.hasOwn(users, n) || await dbUser(env, n, true)) return json({ error: "Ese usuario ya existe" }, 409);
          const salt = randomHex(16);
          await db.prepare("INSERT INTO users (name, salt, hash, ver, created) VALUES (?1, ?2, ?3, 1, ?4)")
            .bind(n, salt, await hashPass(String(pass), salt), Date.now()).run();
          return json({ ok: true, name: n });
        }
        if (name && Object.hasOwn(users, name))
          return json({ error: "Este usuario es fijo (está en USERS en Cloudflare) y solo se cambia allá" }, 400);
        if (name && req.method === "DELETE") {
          await db.batch([db.prepare("DELETE FROM users WHERE name = ?1").bind(name),
                          db.prepare("DELETE FROM progress WHERE user = ?1").bind(name)]);
          userCache.delete(name);
          return json({ ok: true });
        }
        if (name && action === "password" && req.method === "POST") {
          const { pass } = await req.json();
          if (String(pass || "").length < 6) return json({ error: "La contraseña debe tener al menos 6 caracteres" }, 400);
          const salt = randomHex(16);
          const r = await db.prepare("UPDATE users SET salt = ?2, hash = ?3, ver = ver + 1 WHERE name = ?1")
            .bind(name, salt, await hashPass(String(pass), salt)).run();
          userCache.delete(name);
          if (!r.meta?.changes) return json({ error: "No existe ese usuario" }, 404);
          return json({ ok: true });
        }
        return json({ error: "No encontrado" }, 404);
      }

      /* ----- Cambiar mi propia contraseña ----- */
      if (pathname === "/me/password" && req.method === "POST") {
        if (!authed) return json({ error: "Sesión inválida" }, 401);
        if (Object.hasOwn(users, data.u)) return json({ error: "Tu usuario es fijo; la clave se cambia en Cloudflare (USERS)" }, 400);
        const { old, pass } = await req.json();
        const row = await dbUser(env, data.u, true);
        if (!row || !(await safeEqual(row.hash, await hashPass(String(old || ""), row.salt))))
          return json({ error: "La contraseña actual no es correcta" }, 400);
        if (String(pass || "").length < 6) return json({ error: "La contraseña nueva debe tener al menos 6 caracteres" }, 400);
        const salt = randomHex(16);
        await (await appDb(env)).prepare("UPDATE users SET salt = ?2, hash = ?3, ver = ver + 1 WHERE name = ?1")
          .bind(data.u, salt, await hashPass(String(pass), salt)).run();
        userCache.delete(data.u);
        const session = await signSession({ u: data.u, v: row.ver + 1, exp: Date.now() + SESSION_DAYS * 864e5 }, env.SESSION_SECRET);
        return json({ ok: true, session });
      }

      if (pathname === "/meta") {
        if (!authed) return json({ error: "Sesión inválida" }, 401);
        if (!env.TMDB_KEY) return json({ error: "Falta TMDB_KEY" }, 501);
        const q = url.searchParams.get("q") || "", y = url.searchParams.get("y") || "";
        const cacheKey = new Request("https://micine-cache/meta3?q=" + encodeURIComponent(q) + "&y=" + y);
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
        const db = await appDb(env);
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
        const t = await signSession({ u: data.u, v: data.v, c: [id, ...subs], exp: Date.now() + 8 * 3600e3 }, env.SESSION_SECRET);
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
        if (!ct || !Array.isArray(ct.c) || !ct.c.includes(id) || !(await userValid(env, users, ct.u, ct.v)))
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
          admin: isAdmin,
          fixed: Object.hasOwn(users, data.u),
        });
      }

      return json({ error: "No encontrado" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

/* ---------- Base de datos (avance y usuarios) ---------- */
let dbReady = false;
async function appDb(env) {
  if (!env.DB) return null;
  if (!dbReady) {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS progress (
         user TEXT NOT NULL, id TEXT NOT NULL, pos INTEGER NOT NULL DEFAULT 0,
         done INTEGER NOT NULL DEFAULT 0, t INTEGER NOT NULL, PRIMARY KEY (user, id))`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
         name TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL,
         ver INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL)`),
    ]);
    dbReady = true;
  }
  return env.DB;
}

/* ---------- Usuarios creados desde la app ---------- */
const userCache = new Map(); // nombre → { row, at }
async function dbUser(env, name, fresh = false) {
  const c = userCache.get(name);
  if (!fresh && c && Date.now() - c.at < 30e3) return c.row;
  const db = await appDb(env);
  const row = db ? await db.prepare("SELECT name, salt, hash, ver FROM users WHERE name = ?1").bind(name).first() : null;
  userCache.set(name, { row, at: Date.now() });
  return row;
}
async function userValid(env, users, name, ver) {
  if (!name) return false;
  if (Object.hasOwn(users, name)) return true;
  const row = await dbUser(env, name);
  return !!row && row.ver === (ver || 0);
}
async function hashPass(pass, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(saltHex.match(/../g), h => parseInt(h, 16));
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 20000 }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randomHex(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
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
    backdrop: m.backdrop_path ? "https://image.tmdb.org/t/p/w1280" + m.backdrop_path : null,
    genres: (m.genre_ids || []).map(g => GENRES[g]).filter(Boolean),
  };
}
const GENRES = { 28: "Acción", 12: "Aventura", 16: "Animación", 35: "Comedia", 80: "Crimen",
  99: "Documental", 18: "Drama", 10751: "Familia", 14: "Fantasía", 36: "Historia", 27: "Terror",
  10402: "Música", 9648: "Misterio", 10749: "Romance", 878: "Ciencia ficción", 10770: "Película de TV",
  53: "Suspenso", 10752: "Bélica", 37: "Western" };

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
