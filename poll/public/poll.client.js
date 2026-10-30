/* Clan Meeting Poll - browser code - Christoforos Pliatsikas
   Slots are fixed in Greek time (Europe/Athens): Sun-Thu, 19:00-22:00, one hour each.
   Each slot is shown at its next real date, converted to the viewer's own time zone. */
"use strict";

const GR = "Europe/Athens";
const DAYS = ["Sun","Mon","Tue","Wed","Thu"];             // poll day index 0..4 = JS weekday 0..4
const HOURS = [19,20,21,22];
const VIEW = (()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC"}catch(e){return "UTC"}})();
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

/* ---------- time ---------- */
const fmtCache={};
function parts(ts,tz){
  const f=fmtCache[tz]||(fmtCache[tz]=new Intl.DateTimeFormat("en-US",{timeZone:tz,hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",weekday:"short"}));
  const o={};for(const p of f.formatToParts(new Date(ts))) o[p.type]=p.value;
  return {y:+o.year,m:+o.month,d:+o.day,h:+o.hour%24,mi:+o.minute,s:+o.second,wd:o.weekday};
}
const offMin=(ts,tz)=>{const p=parts(ts,tz);return (Date.UTC(p.y,p.m-1,p.d,p.h,p.mi,p.s)-Math.floor(ts/1000)*1000)/60000};
function wallToUtc(y,m,d,min,tz){const g=Date.UTC(y,m-1,d,0,min);const o1=offMin(g,tz);let t=g-o1*60000;const o2=offMin(t,tz);if(o2!==o1)t=g-o2*60000;return t}
const WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
/* next start (epoch ms) of poll day di at hour h, Greek time */
function slotStart(di,h){
  const now=Date.now(), p=parts(now,GR);
  const todayWd=WD.indexOf(p.wd);
  for(let add=0;add<8;add++){
    const t=new Date(Date.UTC(p.y,p.m-1,p.d+add));
    if(t.getUTCDay()!==di) continue;
    const s=wallToUtc(t.getUTCFullYear(),t.getUTCMonth()+1,t.getUTCDate(),h*60,GR);
    if(s+3600000>now||add>0) return s;
  }
  return now;
}
const fmt=(ts,tz,o)=>new Intl.DateTimeFormat("en-GB",{timeZone:tz,...o}).format(new Date(ts));
function slotInfo(di,h){
  const s=slotStart(di,h);
  const local=fmt(s,VIEW,{hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
  const localDay=fmt(s,VIEW,{weekday:"short"});
  const grTime=`${String(h).padStart(2,"0")}:00`;
  const same=local===grTime&&localDay===DAYS[di];
  return {id:`d${di}h${h}`,di,h,local,localDay,shifted:localDay!==DAYS[di],gr:same?"":`${DAYS[di]} ${grTime} GR`,label:`${localDay} ${local}`};
}
let SLOTS=[];
const buildSlots=()=>{SLOTS=[];for(let di=0;di<DAYS.length;di++)for(const h of HOURS)SLOTS.push(slotInfo(di,h))};
const slotById=id=>SLOTS.find(s=>s.id===id);

/* ---------- api ---------- */
async function api(path,opt={}){
  const r=await fetch(path,{credentials:"same-origin",cache:"no-store",...opt});
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw Object.assign(new Error(d.error||`Error ${r.status}`),{status:r.status});
  return d;
}

/* ---------- vote grid ---------- */
function gridHead(){return `<tr><th class="rowh"></th>${DAYS.map((d,di)=>{const s=slotInfo(di,HOURS[0]);return `<th>${esc(s.shifted?s.localDay+"*":d)}</th>`}).join("")}</tr>`}
function renderPick(mine){
  const sel=new Set(mine||[]);
  $("pick").innerHTML=gridHead()+HOURS.map(h=>`<tr><th class="rowh">${String(h).padStart(2,"0")}:00<br><span class="sub">GR</span></th>${
    DAYS.map((_,di)=>{const s=slotById(`d${di}h${h}`);return `<td><label class="cell" for="c-${s.id}"><input type="checkbox" id="c-${s.id}" value="${s.id}"${sel.has(s.id)?" checked":""}>
      <span class="t">${esc(s.local)}</span>${s.shifted?`<span class="d">${esc(s.localDay)}</span>`:""}</label></td>`}).join("")}</tr>`).join("");
}
const picked=()=>[...document.querySelectorAll("#pick input:checked")].map(i=>i.value);

async function save(){
  const m=$("msg");m.className="msg";
  const slots=picked();
  if(!slots.length){m.className="msg err";m.textContent="Tick at least one time.";return}
  $("save").disabled=true;m.textContent="Saving…";
  try{await api("/api/vote",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({slots})});
    m.className="msg ok";m.textContent=`Saved: ${slots.length} time${slots.length>1?"s":""}. You can change it any time.`;loadResults();}
  catch(e){m.className="msg err";m.textContent=e.status===401?"Your login expired. Please log in again.":e.message;if(e.status===401)init()}
  finally{$("save").disabled=false}
}

/* ---------- results ---------- */
async function loadResults(){
  let d;try{d=await api("/api/results")}catch(e){$("updated").textContent=e.status===401?"":"Could not load the results. Retrying…";return}
  $("results-box").hidden=false;
  const counts=d.counts||{}, voters=d.voters||0;
  const max=Math.max(0,...Object.values(counts));
  $("summary").textContent=voters?`${voters} member${voters>1?"s":""} voted. Gold = most requested.`:"No votes yet.";
  if(!voters){$("bars").innerHTML=`<p class="empty">The chart appears after the first vote.</p>`;$("heat").innerHTML="";return}
  const sorted=[...SLOTS].sort((a,b)=>(counts[b.id]||0)-(counts[a.id]||0)||a.di-b.di||a.h-b.h);
  $("bars").innerHTML=sorted.map(s=>{const n=counts[s.id]||0,top=n===max&&max>0;
    return `<div class="bar${top?" top":""}" title="${esc(s.gr||s.label)}"><span class="lab">${esc(s.label)}</span><span class="track"><span class="fill" style="--w:${max?(n/max*100).toFixed(1):0}%"></span></span><span class="num"><b>${n}</b> · ${Math.round(n/voters*100)}%</span></div>`}).join("");
  $("heat").innerHTML=gridHead()+HOURS.map(h=>`<tr><th class="rowh">${String(h).padStart(2,"0")}:00<br><span class="sub">GR</span></th>${
    DAYS.map((_,di)=>{const s=slotById(`d${di}h${h}`),n=counts[s.id]||0,a=max?n/max:0;
      return `<td><div class="cell${n?"":" zero"}${n===max&&max>0?" top":""}${a>.55?" hi":""}" style="--a:${a.toFixed(2)}" title="${esc(s.label)}: ${n}"><span class="n">${n}</span><span class="gr">${esc(s.local)}</span></div></td>`}).join("")}</tr>`).join("");
  $("updated").textContent="Updated "+fmt(Date.now(),VIEW,{hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"})+" · refreshes by itself";
}

/* ---------- admin ---------- */
async function adminLoad(){
  const m=$("admin-msg"),k=$("admin-key").value.trim();m.className="msg";
  if(!k){m.className="msg err";m.textContent="Type the admin key.";return}
  try{
    const d=await api("/api/admin/votes",{headers:{"X-Admin-Key":k}});
    m.textContent=`${d.voters} vote${d.voters===1?"":"s"}.`;
    $("admin-out").innerHTML=d.votes.length?`<table class="vt"><thead><tr><th>Name</th><th>Times (your time zone)</th><th></th></tr></thead><tbody>${
      d.votes.sort((a,b)=>a.name.localeCompare(b.name)).map(v=>`<tr><td><b>${esc(v.name)}</b></td><td class="s">${esc(v.slots.map(id=>slotById(id)?.label||id).join(", "))}</td><td><button class="ghost sm" data-del="${esc(v.id)}" data-name="${esc(v.name)}" type="button">Delete</button></td></tr>`).join("")
    }</tbody></table><p class="btns"><button class="ghost sm" id="admin-reset" type="button">Delete all votes</button></p>`:`<p class="sub">No votes yet.</p>`;
  }catch(e){m.className="msg err";m.textContent=e.message;$("admin-out").innerHTML=""}
}
let pendingDel=null;
async function adminClick(ev){
  const b=ev.target.closest("button");if(!b) return;
  const m=$("admin-msg"),k=$("admin-key").value.trim();
  const id=b.id==="admin-reset"?"*":b.dataset.del;if(id===undefined) return;
  if(pendingDel!==id){pendingDel=id;m.className="msg err";m.textContent=id==="*"?"Click \"Delete all votes\" again to confirm.":`Click Delete again to remove ${b.dataset.name}'s vote.`;return}
  pendingDel=null;
  try{await api("/api/admin/votes"+(id==="*"?"":"/"+encodeURIComponent(id)),{method:"DELETE",headers:{"X-Admin-Key":k}});await adminLoad();loadResults();m.className="msg ok";m.textContent="Deleted."}
  catch(e){m.className="msg err";m.textContent=e.message}
}

/* ---------- start ---------- */
async function init(){
  $("tz").textContent=VIEW.replace(/_/g," ");
  buildSlots();
  let me;try{me=await api("/api/me")}catch(e){me={loggedIn:false}}
  $("login-box").hidden=me.loggedIn;$("vote-box").hidden=!me.loggedIn;$("results-box").hidden=!me.loggedIn;
  if(me.loggedIn){$("me").textContent=me.name;renderPick(me.slots);loadResults();
    if(me.slots) {$("msg").className="msg";$("msg").textContent="Your saved vote is loaded. Change it and save again if you want.";}}
}
document.addEventListener("DOMContentLoaded",()=>{
  $("save").addEventListener("click",save);
  $("all").addEventListener("click",()=>document.querySelectorAll("#pick input").forEach(i=>i.checked=true));
  $("none").addEventListener("click",()=>document.querySelectorAll("#pick input").forEach(i=>i.checked=false));
  $("logout").addEventListener("click",async()=>{try{await api("/auth/logout",{method:"POST"})}catch(e){}init()});
  $("admin-load").addEventListener("click",adminLoad);
  $("admin-out").addEventListener("click",adminClick);
  init();
  setInterval(()=>{if(!document.hidden&&!$("results-box").hidden)loadResults()},30000);
});
