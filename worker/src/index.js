// One Video's Cloudflare Worker: stores the video in R2 (no download fees) and decides who may
// upload or watch by asking Firestore with the caller's Firebase ID token, so the existing
// rules in ~/projects/lecture-player/firestore.rules stay the only access list:
//   - upload/delete: the caller can read config/access (only the admin can) → Alex;
//   - watch: the caller can read oneVideo/current (Alex + config/access.oneVideo).
// Playback links are /v/<key>?exp=…&sig=… (HMAC with the SIGNING_KEY secret, 12 h), because a
// <video> element can't send an Authorization header. Range requests are passed to R2, so the
// browser streams and can start at any time without downloading what's before it.
//
// Uploads are multipart (R2 binding), because a Worker request body is capped at 100 MB:
// POST /upload/start → PUT /upload/part (≤ PART_BYTES each) → POST /upload/complete.

const PART_BYTES = 50 * 1024 * 1024; // every part but the last must be the same size (≥ 5 MiB)
// Keeps R2 inside its free 10 GB-month: the bucket holds one video, plus the previous one for the
// moment before it's deleted, so 2 × 4 GB stays under 10 GB. Uploads above this are refused.
const MAX_BYTES = 4 * 1000 ** 3;
const MAX_PARTS = Math.ceil(MAX_BYTES / PART_BYTES);
const LINK_SECONDS = 12 * 3600;
const ALLOWED_ORIGINS = ["https://alexknight0.github.io"];
const KEY_RE = /^oneVideo\/[\w.-]{1,120}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (url.pathname.startsWith("/v/") && (request.method === "GET" || request.method === "HEAD")) {
        return await serveVideo(request, env, url);
      }
      const route = `${request.method} ${url.pathname}`;
      const handler = ROUTES[route];
      if (!handler) return json({ error: "not found" }, 404, cors);
      return await handler(request, env, url, cors);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status, cors);
      console.error(err);
      return json({ error: "server error" }, 500, cors);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const ok = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return ok ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  } : { Vary: "Origin" };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

// --- access, decided by Firestore's rules ---
function bearer(request) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer (\S+)$/);
  if (!m) throw new HttpError(401, "sign in first");
  return m[1];
}

async function firestoreGet(env, idToken, path) {
  return fetch(`${env.FIRESTORE_BASE}/${path}`, { headers: { Authorization: `Bearer ${idToken}` } });
}

async function requireAdmin(request, env) {
  const r = await firestoreGet(env, bearer(request), "config/access");
  // 404 = the admin may read it but it doesn't exist yet; anyone else gets 403 (or 401).
  if (r.status !== 200 && r.status !== 404) throw new HttpError(403, "only the owner can change the video");
}

async function requireWatcher(request, env) {
  const r = await firestoreGet(env, bearer(request), "oneVideo/current");
  if (r.status === 404) throw new HttpError(404, "no video yet");
  if (r.status !== 200) throw new HttpError(403, "not allowed to watch");
  const doc = await r.json();
  return doc.fields || {};
}

// --- signed playback links ---
async function hmac(env, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function serveVideo(request, env, url) {
  const key = decodeURIComponent(url.pathname.slice(3));
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") || "";
  if (!KEY_RE.test(key) || !Number.isFinite(exp)) return new Response("bad link", { status: 400 });
  if (exp < Date.now() / 1000) return new Response("link expired", { status: 403 });
  if (!safeEqual(sig, await hmac(env, `${key}\n${exp}`))) return new Response("bad signature", { status: 403 });

  const base = { "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
  if (request.method === "HEAD") {
    const head = await env.BUCKET.head(key);
    if (!head) return new Response(null, { status: 404 });
    return new Response(null, { headers: { ...base, "Content-Length": String(head.size),
      "Content-Type": head.httpMetadata?.contentType || "video/mp4", ETag: head.httpEtag } });
  }

  const hasRange = request.headers.has("Range");
  let obj;
  try {
    obj = await env.BUCKET.get(key, { range: request.headers });
  } catch {
    const head = await env.BUCKET.head(key);
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head ? head.size : 0}` } });
  }
  if (!obj) return new Response("not found", { status: 404 });
  const headers = { ...base, "Content-Type": obj.httpMetadata?.contentType || "video/mp4", ETag: obj.httpEtag };
  if (hasRange && obj.range) {
    const offset = obj.range.offset ?? (obj.size - obj.range.suffix);
    const length = obj.range.length ?? (obj.size - offset);
    headers["Content-Range"] = `bytes ${offset}-${offset + length - 1}/${obj.size}`;
    headers["Content-Length"] = String(length);
    return new Response(obj.body, { status: 206, headers });
  }
  headers["Content-Length"] = String(obj.size);
  return new Response(obj.body, { status: 200, headers });
}

// --- routes ---
const ROUTES = {
  // Watchers: get a fresh playback link for the saved video (key from the Firestore doc).
  async "POST /play"(request, env, url, cors) {
    const fields = await requireWatcher(request, env);
    const key = fields.key?.stringValue;
    if (!key || !KEY_RE.test(key)) throw new HttpError(404, "no video yet");
    const exp = Math.floor(Date.now() / 1000) + LINK_SECONDS;
    const sig = await hmac(env, `${key}\n${exp}`);
    return json({ url: `${url.origin}/v/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`, expires: exp }, 200, cors);
  },

  async "POST /upload/start"(request, env, url, cors) {
    await requireAdmin(request, env);
    const { name = "video", type = "", size } = await request.json();
    if (!/^video\//.test(type)) throw new HttpError(400, "not a video");
    if (!(Number(size) > 0)) throw new HttpError(400, "missing size");
    if (Number(size) > MAX_BYTES) throw new HttpError(413, `videos over ${MAX_BYTES / 1e9} GB aren't allowed (free storage limit)`);
    const safe = String(name).replace(/[^\w.-]+/g, "_").slice(-80) || "video";
    const key = `oneVideo/${Date.now()}-${safe}`;
    const up = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: type } });
    return json({ key, uploadId: up.uploadId, partBytes: PART_BYTES }, 200, cors);
  },

  async "PUT /upload/part"(request, env, url, cors) {
    await requireAdmin(request, env);
    const key = url.searchParams.get("key");
    const uploadId = url.searchParams.get("uploadId");
    const part = Number(url.searchParams.get("part"));
    if (!KEY_RE.test(key || "") || !uploadId || !(part >= 1 && part <= MAX_PARTS)) throw new HttpError(400, "bad part");
    const len = Number(request.headers.get("Content-Length"));
    if (!(len > 0 && len <= PART_BYTES)) throw new HttpError(400, "bad part size");
    const up = env.BUCKET.resumeMultipartUpload(key, uploadId);
    const done = await up.uploadPart(part, request.body);
    return json({ partNumber: done.partNumber, etag: done.etag }, 200, cors);
  },

  async "POST /upload/complete"(request, env, url, cors) {
    await requireAdmin(request, env);
    const { key, uploadId, parts } = await request.json();
    if (!KEY_RE.test(key || "") || !uploadId || !Array.isArray(parts) || !parts.length || parts.length > MAX_PARTS) throw new HttpError(400, "bad upload");
    const obj = await env.BUCKET.resumeMultipartUpload(key, uploadId).complete(parts);
    return json({ key, size: obj.size }, 200, cors);
  },

  async "POST /upload/abort"(request, env, url, cors) {
    await requireAdmin(request, env);
    const { key, uploadId } = await request.json();
    if (KEY_RE.test(key || "") && uploadId) await env.BUCKET.resumeMultipartUpload(key, uploadId).abort().catch(() => {});
    return json({ ok: true }, 200, cors);
  },

  async "DELETE /object"(request, env, url, cors) {
    await requireAdmin(request, env);
    const key = url.searchParams.get("key");
    if (!KEY_RE.test(key || "")) throw new HttpError(400, "bad key");
    await env.BUCKET.delete(key);
    return json({ ok: true }, 200, cors);
  },
};
