// Mi Cine — servidor de acceso (Cloudflare Worker)
// Valida usuarios propios y entrega permisos temporales de SOLO LECTURA
// a la carpeta de películas, usando una cuenta de servicio de Google.
//
// Variables (Settings → Variables and Secrets), todas como "Secret":
//   SA_JSON         contenido completo del archivo .json de la cuenta de servicio
//   FOLDER_ID       ID de la carpeta "Peliculas" de Drive
//   USERS           {"jorge":"clave1","mama":"clave2"}  (usuario en minúsculas)
//   SESSION_SECRET  texto largo y aleatorio (firma las sesiones)

const ALLOWED_ORIGINS = ["https://jorgeflore.github.io", "http://localhost:8000"];
const SESSION_DAYS = 30;
let cached = null; // token de Google en caché

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Vary": "Origin",
    };
    const json = (o, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const { pathname } = new URL(req.url);

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

      if (pathname === "/token") {
        const s = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
        const data = await verifySession(s, env.SESSION_SECRET);
        // Si borras a alguien de USERS, pierde el acceso de inmediato.
        if (!data || !Object.hasOwn(users, data.u)) return json({ error: "Sesión inválida" }, 401);
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
