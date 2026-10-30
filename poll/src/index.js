/**
 * Clan meeting poll - Cloudflare Worker.
 * Author: Christoforos Pliatsikas
 *
 * - Login with Discord (OAuth2, scopes: identify + guilds.members.read).
 *   Only members of the clan Discord server (GUILD_ID) can log in.
 * - One vote per Discord account; voting again replaces your own vote.
 * - Voters see only totals. The admin (POLL_ADMIN_KEY) sees names and can delete votes.
 * - Serves its own page, so the session cookie is first-party (HttpOnly, Secure, SameSite=Lax).
 *
 * Secrets: DISCORD_CLIENT_SECRET, SESSION_SECRET, POLL_ADMIN_KEY
 * Vars:    DISCORD_CLIENT_ID, GUILD_ID
 */
import { DurableObject } from "cloudflare:workers";
import PAGE from "../public/index.html";
import CSS from "../public/poll.css";
import JS from "../public/poll.client.js";
import CREST from "../public/crest.jpg";
import ICON from "../public/crest-64.png";

/* Slots are fixed in Greek time: day 0 = Sunday ... 4 = Thursday, hours 19-22 (one hour each). */
const DAYS = 5, HOURS = [19, 20, 21, 22];
const SLOT_IDS = new Set();
for (let d = 0; d < DAYS; d++) for (const h of HOURS) SLOT_IDS.add(`d${d}h${h}`);

const SESSION_DAYS = 7;
const WRITE_LIMIT = 20, WRITE_WINDOW = 60_000;

/* ---------------- storage ---------------- */
export class PollStore extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.hits = new Map(); }
  async all() { return (await this.ctx.storage.get("votes")) || {}; }
  async put(id, v) { const a = await this.all(); a[id] = v; await this.ctx.storage.put("votes", a); }
  async remove(id) {
    if (id === null) return this.ctx.storage.put("votes", {});
    const a = await this.all(); delete a[id]; await this.ctx.storage.put("votes", a);
  }
  rateOk(ip) {
    const now = Date.now(), q = (this.hits.get(ip) || []).filter(t => now - t < WRITE_WINDOW);
    if (q.length >= WRITE_LIMIT) { this.hits.set(ip, q); return false; }
    q.push(now); this.hits.set(ip, q); if (this.hits.size > 500) this.hits.clear();
    return true;
  }
}

/* ---------------- helpers ---------------- */
const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = s => b64url(enc.encode(s));
const fromB64url = s => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

async function hmac(secret, data) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
async function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}
async function makeSession(env, user) {
  const body = b64urlStr(JSON.stringify({ id: user.id, name: user.name, exp: Date.now() + SESSION_DAYS * 86400_000 }));
  return body + "." + await hmac(env.SESSION_SECRET, body);
}
async function readSession(env, req) {
  const raw = cookie(req, "sess");
  if (!raw || !env.SESSION_SECRET) return null;
  const [body, sig] = raw.split(".");
  if (!body || !sig || !(await safeEqual(sig, await hmac(env.SESSION_SECRET, body)))) return null;
  try { const s = JSON.parse(fromB64url(body)); return s.exp > Date.now() && s.id ? s : null; } catch { return null; }
}
function cookie(req, name) {
  const h = req.headers.get("Cookie") || "";
  for (const part of h.split(/;\s*/)) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1); }
  return null;
}
const setCookie = (name, val, maxAge, path = "/") =>
  `${name}=${val}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const resp = (body, status = 200, type = "application/json; charset=utf-8", extra = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": type, "Cache-Control": "no-store", ...SEC_HEADERS, ...extra } });
const json = (data, status = 200, extra = {}) => resp(data, status, undefined, extra);
const err = (status, msg) => json({ error: msg }, status);
const redirect = (to, cookies = []) => {
  const h = new Headers({ Location: to, "Cache-Control": "no-store", ...SEC_HEADERS });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers: h });
};
const page = (title, text) => resp(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="author" content="Christoforos Pliatsikas"><title>${title}</title><link rel="icon" href="/favicon.png"><link rel="stylesheet" href="/poll.css"><main class="wrap"><header class="hero"><img class="crest" src="/crest.jpg" alt="4oD crest" width="112" height="112"></header><div class="box"><h2>${title}</h2><p>${text}</p><p><a class="btn" href="/">Back to the poll</a></p></div><footer class="wm">created by Ankalime</footer></main>`, 200, "text/html; charset=utf-8");

/* ---------------- Discord OAuth ---------------- */
const discordApi = env => (env.DISCORD_API || "https://discord.com/api").replace(/\/$/, "");
const discordAuth = env => env.DISCORD_AUTHORIZE || "https://discord.com/oauth2/authorize";
const redirectUri = url => `${url.origin}/auth/callback`;

async function login(req, env, url) {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.SESSION_SECRET) return page("Not set up", "The poll is not configured yet. Tell the clan leader.");
  if (!env.GUILD_ID) return page("Not set up", "The poll has no clan Discord server set. Tell the clan leader.");
  const state = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const q = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, redirect_uri: redirectUri(url), response_type: "code", scope: "identify guilds.members.read", state, prompt: "none" });
  return redirect(`${discordAuth(env)}?${q}`, [setCookie("oauth_state", state, 600, "/auth")]);
}

async function callback(req, env, url) {
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  const clearState = setCookie("oauth_state", "", 0, "/auth");
  if (url.searchParams.get("error")) return page("Login cancelled", "You cancelled the Discord login. You can try again.");
  if (!code || !state || !(await safeEqual(state, cookie(req, "oauth_state") || ""))) return page("Login failed", "The login link expired or is not valid. Please try again.");
  try {
    const tok = await fetch(`${discordApi(env)}/oauth2/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: redirectUri(url) }),
    });
    if (!tok.ok) return page("Login failed", "Discord did not accept the login. Please try again.");
    const { access_token } = await tok.json();
    const auth = { Authorization: `Bearer ${access_token}` };
    const me = await fetch(`${discordApi(env)}/users/@me`, { headers: auth });
    if (!me.ok) return page("Login failed", "Could not read your Discord account. Please try again.");
    const user = await me.json();
    const mem = await fetch(`${discordApi(env)}/users/@me/guilds/${encodeURIComponent(env.GUILD_ID)}/member`, { headers: auth });
    if (mem.status === 404 || mem.status === 403) return page("Clan members only", "This poll is only for members of the clan Discord server.");
    if (!mem.ok) return page("Login failed", "Could not check the clan server membership. Please try again in a minute.");
    const member = await mem.json();
    const name = String(member.nick || user.global_name || user.username || "member").slice(0, 40);
    const sess = await makeSession(env, { id: String(user.id), name });
    // the Discord access token is not kept anywhere
    return redirect("/", [clearState, setCookie("sess", sess, SESSION_DAYS * 86400)]);
  } catch (e) {
    console.log("discord login error", e && e.message);
    return page("Login failed", "Could not reach Discord. Please try again.");
  }
}

/* ---------------- API ---------------- */
function sameOrigin(req, url) {
  const o = req.headers.get("Origin");
  return !o || o === url.origin;
}
function tally(votes) {
  const counts = {}; for (const id of SLOT_IDS) counts[id] = 0;
  for (const v of Object.values(votes)) for (const s of v.slots) if (s in counts) counts[s]++;
  return { voters: Object.keys(votes).length, counts };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const store = env.STORE.get(env.STORE.idFromName("poll"));

    if (req.method === "GET" && (path === "/" || path === "/index.html")) return resp(PAGE, 200, "text/html; charset=utf-8");
    if (req.method === "GET" && path === "/poll.css") return resp(CSS, 200, "text/css; charset=utf-8");
    if (req.method === "GET" && path === "/poll.client.js") return resp(JS, 200, "text/javascript; charset=utf-8");
    if (req.method === "GET" && path === "/crest.jpg") return new Response(CREST, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400", ...SEC_HEADERS } });
    if (req.method === "GET" && (path === "/favicon.png" || path === "/favicon.ico")) return new Response(ICON, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400", ...SEC_HEADERS } });
    if (path === "/healthz") return resp("ok", 200, "text/plain");

    if (req.method === "GET" && path === "/auth/login") return login(req, env, url);
    if (req.method === "GET" && path === "/auth/callback") return callback(req, env, url);
    if (req.method === "POST" && path === "/auth/logout") {
      if (!sameOrigin(req, url)) return err(403, "Bad origin.");
      return json({ ok: true }, 200, { "Set-Cookie": setCookie("sess", "", 0) });
    }

    /* admin: names + delete, with POLL_ADMIN_KEY */
    if (path.startsWith("/api/admin/votes")) {
      if (!(await safeEqual(req.headers.get("X-Admin-Key") || "", env.POLL_ADMIN_KEY || "\u0000"))) return err(401, "Wrong admin key.");
      if (req.method === "GET" && path === "/api/admin/votes") {
        const votes = await store.all();
        return json({ ...tally(votes), votes: Object.entries(votes).map(([id, v]) => ({ id, name: v.name, slots: v.slots, ts: v.ts })) });
      }
      if (req.method === "DELETE") {
        const id = path === "/api/admin/votes" ? null : decodeURIComponent(path.slice("/api/admin/votes/".length));
        await store.remove(id);
        return json({ ok: true });
      }
      return err(405, "Method not allowed.");
    }

    if (!path.startsWith("/api/")) return err(404, "Not found.");
    const sess = await readSession(env, req);

    if (req.method === "GET" && path === "/api/me") {
      if (!sess) return json({ loggedIn: false });
      const v = (await store.all())[sess.id];
      return json({ loggedIn: true, name: sess.name, slots: v ? v.slots : null });
    }
    if (!sess) return err(401, "Please log in with Discord first.");

    if (req.method === "GET" && path === "/api/results") return json(tally(await store.all()));

    if (req.method === "PUT" && path === "/api/vote") {
      if (!sameOrigin(req, url)) return err(403, "Bad origin.");
      if (!(await store.rateOk(req.headers.get("CF-Connecting-IP") || "unknown"))) return err(429, "Too many saves. Wait a minute and try again.");
      let body;
      try { const t = await req.text(); if (t.length > 4096) throw 0; body = JSON.parse(t); } catch { return err(400, "Bad request."); }
      const slots = Array.isArray(body && body.slots) ? [...new Set(body.slots)] : null;
      if (!slots || !slots.length) return err(400, "Pick at least one time slot.");
      if (!slots.every(s => SLOT_IDS.has(s))) return err(400, "Unknown time slot.");
      await store.put(sess.id, { name: sess.name, slots, ts: Date.now() });
      return json({ ok: true, slots });
    }
    return err(405, "Method not allowed.");
  },
};
