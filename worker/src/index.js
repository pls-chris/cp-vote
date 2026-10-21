/**
 * CP Lineup Vote - vote API on Cloudflare Workers.
 * Author: Christoforos Pliatsikas
 *
 * Votes live in one SQLite-backed Durable Object (strongly consistent,
 * one writer at a time, so two members voting together never overwrite
 * each other).
 *
 * Secrets: PARTY_KEY (required), ADMIN_KEY (optional)
 * Vars:    MEMBERS, ALLOWED_ORIGIN
 */
import { DurableObject } from "cloudflare:workers";

const SUPPORT = ["Bladedancer", "Swordsinger", "Overlord", "Bishop", "Elven Elder", "Shillien Elder", "Warcryer", "Prophet"];
const NUKERS = ["Sorcerer", "Necromancer", "Spellsinger", "Spellhowler"];
const ARCHERS = ["Hawkeye", "Silver Ranger", "Phantom Ranger"];
const TANKS = ["Paladin", "Dark Avenger", "Temple Knight", "Shillien Knight"];
const DDS = ["Gladiator", "Warlord", "Treasure Hunter", "Plains Walker", "Abyss Walker", "Destroyer", "Tyrant", "Warlock",
  "Elemental Summoner", "Phantom Summoner", "Bounty Hunter", "Warsmith"];
// must match site/app.js
const COMP_CLASSES = {
  mage: new Set([...NUKERS, "Bladedancer", "Swordsinger", "Overlord", "Bishop", "Elven Elder", "Shillien Elder"]),
  archer: new Set([...ARCHERS, ...TANKS, "Warlock", "Bladedancer", "Swordsinger", "Elven Elder", "Bishop", "Warcryer", "Prophet"]),
  melee: new Set([...DDS, ...TANKS, "Bladedancer", "Swordsinger", "Bishop", "Warcryer", "Prophet", "Shillien Elder", "Elven Elder"]),
};
const TYPES = ["mage", "melee", "archer"];
const VOL_KEYS = ["buff", "bard", "heal"];
const MAX_BODY = 8 * 1024;
const WRITE_LIMIT = 20;      // writes per IP ...
const WRITE_WINDOW = 60_000; // ... per minute

/* ---------------- storage ---------------- */
export class VoteStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.hits = new Map();
  }
  async list() {
    return (await this.ctx.storage.get("votes")) || {};
  }
  async put(id, vote) {
    const votes = await this.list();
    votes[id] = vote;
    await this.ctx.storage.put("votes", votes);
  }
  async remove(id) {
    const votes = await this.list();
    if (id === null) {
      await this.ctx.storage.put("votes", {});
    } else {
      delete votes[id];
      await this.ctx.storage.put("votes", votes);
    }
  }
  rateOk(ip) {
    const now = Date.now();
    const q = (this.hits.get(ip) || []).filter(t => now - t < WRITE_WINDOW);
    if (q.length >= WRITE_LIMIT) { this.hits.set(ip, q); return false; }
    q.push(now);
    this.hits.set(ip, q);
    if (this.hits.size > 500) this.hits.clear();
    return true;
  }
}

/* ---------------- helpers ---------------- */
const members = env => (env.MEMBERS || "").split(",").map(s => s.trim()).filter(Boolean);

async function keyOk(given, expected) {
  if (!expected || typeof given !== "string") return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function cleanVote(body, member) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Vote must be a JSON object.");
  const { rank, picks: picksIn, vol: volIn } = body;
  if (!Array.isArray(rank) || rank.length !== 3 || [...rank].sort().join() !== [...TYPES].sort().join())
    throw new Error("Rank all three party types, each one once.");
  if (!picksIn || typeof picksIn !== "object") throw new Error("Class picks are missing.");
  const picks = {};
  for (const t of TYPES) {
    const p = picksIn[t];
    if (!Array.isArray(p) || p.length < 2 || p.length > 3) throw new Error(`Give 2 or 3 class picks for ${t}.`);
    if (new Set(p).size !== p.length) throw new Error(`Same class picked twice for ${t}.`);
    if (!p.every(c => typeof c === "string" && COMP_CLASSES[t].has(c))) throw new Error(`Unknown class in the ${t} picks.`);
    picks[t] = p;
  }
  // support boxes per party type: { mage:{buff,bard,heal}, melee:{...}, archer:{...} }
  // an older page sends one {buff,bard,heal} set: apply it to all three types
  const src = volIn && typeof volIn === "object" ? volIn : {};
  const legacy = VOL_KEYS.some(k => k in src);
  const vol = {};
  for (const t of TYPES) {
    const g = legacy ? src : (src[t] && typeof src[t] === "object" ? src[t] : {});
    vol[t] = {};
    for (const k of VOL_KEYS) vol[t][k] = !!g[k];
  }
  return { name: member, rank, picks, vol, ts: Date.now() };
}

function corsHeaders(env, req) {
  const origin = req.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);
  const h = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Party-Key, X-Admin-Key",
    "Access-Control-Max-Age": "86400",
  };
  if (origin && allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(env, req, status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...corsHeaders(env, req),
    },
  });
}

async function readJson(req) {
  const text = await req.text();
  if (!text || text.length > MAX_BODY) throw new Error("Body missing or too large.");
  try { return JSON.parse(text); } catch { throw new Error("Body is not valid JSON."); }
}

/* ---------------- router ---------------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const store = env.STORE.get(env.STORE.idFromName("cp"));
    const err = (s, m) => json(env, req, s, { error: m });

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env, req) });
    if (path === "/healthz") return new Response("ok", { headers: { "Content-Type": "text/plain", ...corsHeaders(env, req) } });
    if (!path.startsWith("/api/votes")) return err(404, "Not found.");

    let tail = null;
    if (path !== "/api/votes") {
      if (!path.startsWith("/api/votes/")) return err(404, "Not found.");
      try { tail = decodeURIComponent(path.slice("/api/votes/".length)); } catch { return err(400, "Bad member name."); }
    }

    if (req.method === "GET" && tail === null) {
      return json(env, req, 200, { members: members(env), votes: await store.list() });
    }

    if (req.method === "PUT" && tail !== null) {
      if (!env.PARTY_KEY) return err(503, "The server has no party key set.");
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      if (!(await store.rateOk(ip))) return err(429, "Too many votes from you. Wait a minute and try again.");
      if (!(await keyOk(req.headers.get("X-Party-Key"), env.PARTY_KEY))) return err(401, "Wrong party key.");
      const member = members(env).find(m => m.toLowerCase() === tail.toLowerCase());
      if (!member) return err(400, "Unknown member name.");
      let vote;
      try { vote = cleanVote(await readJson(req), member); } catch (e) { return err(400, e.message || "Bad vote."); }
      await store.put(member.toLowerCase(), vote);
      return json(env, req, 200, { ok: true, vote });
    }

    if (req.method === "DELETE") {
      if (!(await keyOk(req.headers.get("X-Admin-Key"), env.ADMIN_KEY))) return err(401, "Wrong admin key.");
      await store.remove(tail === null ? null : tail.toLowerCase());
      return json(env, req, 200, { ok: true });
    }

    return err(405, "Method not allowed.");
  },
};
