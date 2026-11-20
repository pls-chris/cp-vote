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
const PARTIES = ["melee", "mage", "any"];
const VOTE_KEY = "votes2";
const MAX_THOUGHTS = 600;
// member renames: old name (lower case) -> new name. Saved votes, schedule hours and
// bank lines/goals of the old name move to the new one the first time they are read.
const RENAMED = {
  morgx: "MorG",                                   // 2026-11-03
  turambar: "Finduilas", gx: "Misa", mitselis: "Enyo",
  samanos: "Gasoline", stelios: "BlackMamba",      // 2026-11-20
};
const MAX_BODY = 8 * 1024;
const WRITE_LIMIT = 20;      // writes per IP ...
const WRITE_WINDOW = 60_000; // ... per minute

/* ---------------- storage ---------------- */
export class VoteStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.hits = new Map();
  }
  /* move everything saved under an old member name to the new name (once per object start) */
  async migrate() {
    if (this.migrated) return;
    const st = this.ctx.storage;
    const moveMap = async key => {
      const all = (await st.get(key)) || {};
      let moved = false;
      for (const [from, to] of Object.entries(RENAMED)) {
        const k = to.toLowerCase();
        if (all[from] && !all[k]) { all[k] = { ...all[from], name: to }; delete all[from]; moved = true; }
      }
      if (moved) await st.put(key, all);
    };
    await moveMap(VOTE_KEY);
    await moveMap("sched");
    for (const prefix of ["bank:e:", "bank:g:"]) {
      const recs = await st.list({ prefix });
      const changed = {};
      for (const [k, r] of recs) {
        const to = r.member && RENAMED[r.member.toLowerCase()];
        if (to) changed[k] = { ...r, member: to };
      }
      if (Object.keys(changed).length) await st.put(changed);
    }
    this.migrated = true;
  }
  async list() {
    await this.migrate();
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
    await this.migrate();
    const all = (await this.ctx.storage.get("sched")) || {};
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
  /* ---- CP bank: one record per line, so no value ever gets big ---- */
  async bankGet() {
    await this.migrate();
    const [entries, goals, audit] = await Promise.all([
      this.ctx.storage.list({ prefix: "bank:e:" }),
      this.ctx.storage.list({ prefix: "bank:g:" }),
      this.ctx.storage.list({ prefix: "bank:a:", reverse: true, limit: AUDIT_SHOW }),
    ]);
    return {
      settings: (await this.ctx.storage.get("bank:settings")) || DEFAULT_SETTINGS,
      entries: [...entries.values()],
      goals: [...goals.values()],
      audit: [...audit.values()],
    };
  }
  async bankOp(op, data) {
    await this.migrate();
    const st = this.ctx.storage, now = Date.now();
    const log = async text => {
      await st.put(`bank:a:${String(now).padStart(15, "0")}:${crypto.randomUUID().slice(0, 8)}`, { ts: now, text });
      const all = await st.list({ prefix: "bank:a:", reverse: true });
      const old = [...all.keys()].slice(AUDIT_KEEP);
      if (old.length) await st.delete(old);
    };
    if (op === "entry.add") {
      const n = (await st.list({ prefix: "bank:e:" })).size;
      if (n >= MAX_ENTRIES) throw new Error(`The ledger is full (${MAX_ENTRIES} lines).`);
      const e = { ...data, id: crypto.randomUUID(), created: now, void: null };
      await st.put("bank:e:" + e.id, e);
      await log(`Added ${e.type}: ${describe(e)}`);
      return e;
    }
    if (op === "entry.void") {
      const e = await st.get("bank:e:" + data.id);
      if (!e) throw new Error("No such ledger line.");
      if (e.void) throw new Error("This line is already voided.");
      e.void = { ts: now, reason: data.reason };
      await st.put("bank:e:" + e.id, e);
      await log(`Voided ${e.type}: ${describe(e)} — ${data.reason}`);
      return e;
    }
    if (op === "goal.save") {
      const old = data.id ? await st.get("bank:g:" + data.id) : null;
      if (data.id && !old) throw new Error("No such goal.");
      const g = { ...(old || {}), ...data, id: data.id || crypto.randomUUID(), created: old ? old.created : now, updated: now };
      if (!old) {
        const goals = [...(await st.list({ prefix: "bank:g:" })).values()];
        if (goals.length >= MAX_GOALS) throw new Error(`At most ${MAX_GOALS} goals.`);
      }
      await st.put("bank:g:" + g.id, g);
      await log(`${old ? "Changed" : "Added"} goal "${g.title}" (${g.cost.toLocaleString("en")} adena, priority ${g.priority}, ${g.status})`);
      return g;
    }
    if (op === "goal.delete") {
      const g = await st.get("bank:g:" + data.id);
      if (!g) throw new Error("No such goal.");
      await st.delete("bank:g:" + data.id);
      await log(`Deleted goal "${g.title}"`);
      return { ok: true };
    }
    if (op === "settings.save") {
      await st.put("bank:settings", data);
      await log(`Settings: crystals ${Object.entries(data.crystal).map(([g, r]) => `${g} ${r[0]}–${r[1]}`).join(", ")}, shop tax ${data.tax}%`);
      return data;
    }
    throw new Error("Unknown operation.");
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

/* ---------------- CP bank ---------------- */
const BANK_TYPES = ["deposit", "income", "purchase", "handout", "sale", "expense", "adjust"];
const GRADES = ["D", "C", "B", "A", "S"];
const DEFAULT_SETTINGS = { crystal: { D: [520, 550], C: [0, 0], B: [0, 0], A: [0, 0], S: [0, 0] }, tax: 0 };
const MAX_ADENA = 1e12, MAX_ENTRIES = 5000, MAX_GOALS = 200, AUDIT_KEEP = 300, AUDIT_SHOW = 100;
const fmtA = n => Number(n).toLocaleString("en");
const describe = e => [e.member, e.adena ? `${fmtA(e.adena)} adena` : "", e.item ? `${e.item.qty}× ${e.item.name} (${fmtA(e.item.value)})` : "",
  e.note ? `"${e.note}"` : ""].filter(Boolean).join(" · ");

const str = (v, max, what, required) => {
  const t = typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").trim() : "";
  if (required && !t) throw new Error(`${what} is missing.`);
  if (t.length > max) throw new Error(`${what}: at most ${max} characters.`);
  return t;
};
const int = (v, lo, hi, what) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} must be a whole number from ${fmtA(lo)} to ${fmtA(hi)}.`);
  return v;
};
function cleanItem(it) {
  if (it === null || it === undefined) return null;
  if (typeof it !== "object" || Array.isArray(it)) throw new Error("Bad item.");
  return {
    id: it.id === null || it.id === undefined ? null : int(it.id, 1, 100000, "Item id"),
    name: str(it.name, 80, "Item name", true),
    qty: int(it.qty, 1, 1e7, "Item quantity"),
    value: int(it.value, 0, MAX_ADENA, "Item value"),
  };
}
function cleanEntry(b, env) {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("Entry must be a JSON object.");
  const type = b.type;
  if (!BANK_TYPES.includes(type)) throw new Error("Unknown entry type.");
  const date = str(b.date, 10, "Date", true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) throw new Error("Date must be YYYY-MM-DD.");
  const mem = str(b.member, 40, "Member", false);
  const member = mem ? members(env).find(m => m.toLowerCase() === mem.toLowerCase()) : "";
  if (mem && !member) throw new Error("Unknown member.");
  const adena = type === "adjust" ? int(b.adena, -MAX_ADENA, MAX_ADENA, "Adena") : int(b.adena ?? 0, 0, MAX_ADENA, "Adena");
  const item = cleanItem(b.item);
  const note = str(b.note, 300, "Note", type === "adjust");
  const goal = b.goal ? str(b.goal, 40, "Goal", false) : null;
  const L = { deposit: "A deposit", income: "Party income", purchase: "A purchase", handout: "A hand-out", sale: "A sale", expense: "A general expense", adjust: "A correction" }[type];
  if (["deposit", "purchase", "handout"].includes(type) && !member) throw new Error(`${L} needs a member.`);
  if (["income", "sale", "expense", "adjust"].includes(type) && member) throw new Error(`${L} belongs to the CP, leave the member empty.`);
  if ((type === "deposit" || type === "income") && !adena && !item) throw new Error("Give adena, an item, or both.");
  if (type === "purchase" && !adena) throw new Error("A purchase needs the adena it cost.");
  if (type === "handout" && (!item || adena)) throw new Error("A hand-out gives an item from the warehouse (no adena).");
  if (type === "sale" && (!item || !adena)) throw new Error("A sale needs the item sold and the adena it brought.");
  if (type === "expense" && (!adena || item)) throw new Error("A general expense needs the adena spent, and no item.");
  if (type === "adjust" && (!adena || item)) throw new Error("An adjustment is adena only (+ or −), with a note why.");
  return { type, date, member, adena, item, note, goal };
}
function cleanGoal(b, env) {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("Goal must be a JSON object.");
  const mem = str(b.member, 40, "Member", false);
  const member = mem ? members(env).find(m => m.toLowerCase() === mem.toLowerCase()) : "";
  if (mem && !member) throw new Error("Unknown member.");
  const status = b.status || "open";
  if (!["open", "done", "dropped"].includes(status)) throw new Error("Bad goal status.");
  const item = b.item ? { id: b.item.id ? int(b.item.id, 1, 100000, "Item id") : null, name: str(b.item.name, 80, "Item name", true) } : null;
  return {
    ...(b.id ? { id: str(b.id, 40, "Goal id", true) } : {}),
    title: str(b.title, 80, "Goal title", true), item, member,
    cost: int(b.cost, 1, MAX_ADENA, "Cost"), priority: int(b.priority, 1, 999, "Priority"), status,
    note: str(b.note, 300, "Note", false),
  };
}
function cleanSettings(b) {
  if (!b || typeof b !== "object" || !b.crystal || typeof b.crystal !== "object") throw new Error("Bad settings.");
  const crystal = {};
  for (const g of GRADES) {
    const r = b.crystal[g] || [0, 0];
    if (!Array.isArray(r) || r.length !== 2) throw new Error(`Crystal ${g}: give min and max.`);
    const [lo, hi] = [int(r[0], 0, 1e7, `Crystal ${g} min`), int(r[1], 0, 1e7, `Crystal ${g} max`)];
    if (hi < lo) throw new Error(`Crystal ${g}: max is lower than min.`);
    crystal[g] = [lo, hi];
  }
  return { crystal, tax: int(b.tax ?? 0, 0, 50, "Shop tax %") };
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
  if (!PARTIES.includes(party)) throw new Error("Question 1: choose Melee farm, Mage PvP or I really don't mind.");
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
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
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
    if (path === "/api/bank") {
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      const isAdmin = await keyOk(req.headers.get("X-Admin-Key"), env.ADMIN_KEY);
      if (req.method === "GET") {
        if (!isAdmin) { const deny = await readGate(req, env, store); if (deny) return deny; }
        return json(env, req, 200, { members: members(env), admin: isAdmin, bank: await store.bankGet() });
      }
      if (req.method === "POST") {
        if (!isAdmin) {
          if (!(await store.rateOk(ip))) return err(429, "Too many tries. Wait a minute.");
          return err(401, "Only the bank admin can change the bank (admin key).");
        }
        let body;
        try { body = await readJson(req); } catch (e) { return err(400, e.message); }
        const op = body && body.op;
        try {
          const data =
            op === "entry.add" ? cleanEntry(body.entry, env) :
            op === "entry.void" ? { id: str(body.id, 40, "Line id", true), reason: str(body.reason, 200, "Reason", true) } :
            op === "goal.save" ? cleanGoal(body.goal, env) :
            op === "goal.delete" ? { id: str(body.id, 40, "Goal id", true) } :
            op === "settings.save" ? cleanSettings(body.settings) : null;
          if (!data) return err(400, "Unknown operation.");
          return json(env, req, 200, { ok: true, result: await store.bankOp(op, data) });
        } catch (e) { return err(400, e.message || "Bad request."); }
      }
      return err(405, "Method not allowed.");
    }

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
