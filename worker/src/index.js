/**
 * CP Lineup Vote - vote API on Cloudflare Workers.
 * Author: Christoforos Pliatsikas
 *
 * Votes live in one SQLite-backed Durable Object (strongly consistent,
 * one writer at a time, so two members voting together never overwrite
 * each other).
 *
 * Secrets: PARTY_KEY (required), ADMIN_KEY (optional)
 * Vars:    MEMBERS, MELEE, ALLOWED_ORIGIN
 */
import { DurableObject } from "cloudflare:workers";

/* Round 2 (2026-11): Q1 melee farm vs mage PvP, fixed melee lineup with free-text
   second thoughts, mage class preferences (up to 3) or "won't play mage".
   Round 1 votes stay untouched in the storage key "votes". Must match site/app.js. */
const MAGE_CLASSES = new Set(["Elven Elder", "Bishop", "Shillien Elder", "Overlord", "Swordsinger", "Bladedancer",
  "Spellsinger", "Spellhowler", "Sorcerer", "Necromancer"]);
const PARTIES = ["melee", "mage"];
const VOTE_KEY = "votes2";
const MAX_THOUGHTS = 600;
// schedule entries saved under an old member name -> new name
const RENAMED = { morgx: "MorG" };
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
    return (await this.ctx.storage.get(VOTE_KEY)) || {};
  }
  async put(id, vote) {
    const votes = await this.list();
    votes[id] = vote;
    await this.ctx.storage.put(VOTE_KEY, votes);
  }
  async remove(id) {
    const votes = await this.list();
    if (id === null) {
      await this.ctx.storage.put(VOTE_KEY, {});
    } else {
      delete votes[id];
      await this.ctx.storage.put(VOTE_KEY, votes);
    }
  }
  /* ---- schedule ---- */
  async schedList() {
    const all = (await this.ctx.storage.get("sched")) || {};
    let moved = false;
    for (const [from, to] of Object.entries(RENAMED)) {
      const k = to.toLowerCase();
      if (all[from] && !all[k]) { all[k] = { ...all[from], name: to }; delete all[from]; moved = true; }
    }
    if (moved) await this.ctx.storage.put("sched", all);
    const cutoff = isoDay(Date.now() - 2 * DAY_MS);
    for (const k of Object.keys(all)) {
      const o = all[k].overrides || {};
      for (const d of Object.keys(o)) if (d < cutoff) delete o[d];
    }
    return all;
  }
  async schedPut(id, entry) {
    const all = await this.schedList();
    all[id] = entry;
    await this.ctx.storage.put("sched", all);
  }
  async schedRemove(id) {
    const all = await this.schedList();
    if (id === null) await this.ctx.storage.put("sched", {});
    else { delete all[id]; await this.ctx.storage.put("sched", all); }
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
const DAY_MS = 86_400_000;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

/* schedule: an "L2 day" runs 06:00 -> 06:00 in the member's own time zone.
   A range [start, end] is minutes after that day's 06:00, in 30-minute steps: 0 = 06:00, 1080 = 00:00, 1440 = 06:00 next morning. */
function cleanRanges(r, what) {
  if (!Array.isArray(r) || r.length > 4) throw new Error(`${what}: at most 4 time ranges per day.`);
  return r.map(x => {
    if (!Array.isArray(x) || x.length !== 2) throw new Error(`${what}: bad time range.`);
    const [a, b] = x;
    for (const v of [a, b]) if (!Number.isInteger(v) || v < 0 || v > 1440 || v % 30) throw new Error(`${what}: times must be in 30-minute steps.`);
    if (b <= a) throw new Error(`${what}: the end must be after the start (the day ends at 06:00).`);
    return [a, b];
  });
}
function cleanSchedule(body, member) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Schedule must be a JSON object.");
  const tz = body.tz;
  if (typeof tz !== "string" || tz.length > 64) throw new Error("Time zone is missing.");
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { throw new Error("Unknown time zone."); }
  const t = body.template && typeof body.template === "object" ? body.template : {};
  const template = {};
  for (let d = 0; d < 7; d++) template[d] = cleanRanges(t[d] || [], "Weekly hours");
  const o = body.overrides && typeof body.overrides === "object" ? body.overrides : {};
  const keys = Object.keys(o);
  if (keys.length > 40) throw new Error("Too many changed days.");
  const lo = isoDay(Date.now() - 2 * DAY_MS), hi = isoDay(Date.now() + 45 * DAY_MS);
  const overrides = {};
  for (const d of keys) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("Bad date.");
    if (d < lo || d > hi) continue;              // silently drop old or far-away days
    overrides[d] = cleanRanges(o[d], d);
  }
  return { name: member, tz, template, overrides, ts: Date.now() };
}
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
  const party = body.party;
  if (!PARTIES.includes(party)) throw new Error("Choose Melee farm or Mage PvP.");
  let thoughts = typeof body.thoughts === "string" ? body.thoughts.replace(/\r/g, "").trim() : "";
  if (thoughts.length > MAX_THOUGHTS) throw new Error(`Second thoughts: at most ${MAX_THOUGHTS} characters.`);
  const noMage = !!body.noMage;
  const mage = Array.isArray(body.mage) ? body.mage : [];
  if (noMage) {
    if (mage.length) throw new Error("You ticked that you won't play mage, so leave the mage choices empty.");
  } else {
    if (mage.length < 1 || mage.length > 3) throw new Error("Give 1 to 3 mage choices, or tick that you won't play mage.");
    if (new Set(mage).size !== mage.length) throw new Error("Same class chosen twice.");
    if (!mage.every(c => typeof c === "string" && MAGE_CLASSES.has(c))) throw new Error("Unknown class in the mage choices.");
  }
  return { name: member, party, thoughts, mage: noMage ? [] : mage, noMage, ts: Date.now() };
}

const melee = env => (env.MELEE || "").split(",").map(s => s.split(":").map(x => x.trim()))
  .filter(p => p.length === 2 && p[0] && p[1]).map(([name, cls]) => ({ name, cls }));

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

/* reading CP data needs the party key; wrong keys count against the rate limit */
async function readGate(req, env, store) {
  if (!env.PARTY_KEY) return json(env, req, 503, { error: "The server has no party key set." });
  if (await keyOk(req.headers.get("X-Party-Key"), env.PARTY_KEY)) return null;
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await store.rateOk(ip))) return json(env, req, 429, { error: "Too many tries. Wait a minute." });
  return json(env, req, 401, { error: "Party key needed." });
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
    const base = path.startsWith("/api/schedule") ? "/api/schedule" : path.startsWith("/api/votes") ? "/api/votes" : null;
    if (!base) return err(404, "Not found.");

    let tail = null;
    if (path !== base) {
      if (!path.startsWith(base + "/")) return err(404, "Not found.");
      try { tail = decodeURIComponent(path.slice(base.length + 1)); } catch { return err(400, "Bad member name."); }
    }

    if (base === "/api/schedule") {
      if (req.method === "GET" && tail === null) {
        const deny = await readGate(req, env, store); if (deny) return deny;
        return json(env, req, 200, { members: members(env), schedule: await store.schedList() });
      }
      if (req.method === "PUT" && tail !== null) {
        if (!env.PARTY_KEY) return err(503, "The server has no party key set.");
        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        if (!(await store.rateOk(ip))) return err(429, "Too many saves from you. Wait a minute and try again.");
        if (!(await keyOk(req.headers.get("X-Party-Key"), env.PARTY_KEY))) return err(401, "Wrong party key.");
        const member = members(env).find(m => m.toLowerCase() === tail.toLowerCase());
        if (!member) return err(400, "Unknown member name.");
        let entry;
        try { entry = cleanSchedule(await readJson(req), member); } catch (e) { return err(400, e.message || "Bad schedule."); }
        await store.schedPut(member.toLowerCase(), entry);
        return json(env, req, 200, { ok: true, entry });
      }
      if (req.method === "DELETE") {
        if (!(await keyOk(req.headers.get("X-Admin-Key"), env.ADMIN_KEY))) return err(401, "Wrong admin key.");
        await store.schedRemove(tail === null ? null : tail.toLowerCase());
        return json(env, req, 200, { ok: true });
      }
      return err(405, "Method not allowed.");
    }

    if (req.method === "GET" && tail === null) {
      const deny = await readGate(req, env, store); if (deny) return deny;
      return json(env, req, 200, { members: members(env), melee: melee(env), votes: await store.list() });
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
