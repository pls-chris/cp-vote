/* CP Lineup Vote - Schedule tab - Christoforos Pliatsikas
   Uses globals from app.js: API, $, esc, store, key, MEMBERS, votesById, validVote, solve, loadVotes.

   Time model
   - An "L2 day" runs 06:00 -> 06:00 in a member's own time zone, so a night session never splits.
   - Ranges are [start, end] minutes after that day's 06:00 (0 = 06:00, 1080 = 00:00, 1440 = 06:00 next morning).
   - Each member saves a weekly template (0 = Monday) plus changed days keyed by date (YYYY-MM-DD, L2 day).
   - Everything is converted to absolute time, then shown in the viewer's own time zone. */
"use strict";

const SCH = {
  DAY_START: 360,                  // 06:00
  SLOT: 30,                        // minutes per slot
  SLOTS: 48,
  DAYS: 7,
  WD: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],
  viewTz: (()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC"}catch(e){return "UTC"}})(),
  data: {},                        // member key -> entry from the server
  ed: null,                        // editor state for the selected member
  edWho: "",
  loaded: false
};

/* ---------- time helpers ---------- */
const _fmtCache = {};
function tzParts(ts, tz){
  const f=_fmtCache[tz]||(_fmtCache[tz]=new Intl.DateTimeFormat("en-US",{timeZone:tz,hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",weekday:"short"}));
  const o={};for(const p of f.formatToParts(new Date(ts))) o[p.type]=p.value;
  return {y:+o.year,m:+o.month,d:+o.day,h:+o.hour%24,mi:+o.minute,s:+o.second,wd:["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].indexOf(o.weekday)};
}
function tzOffsetMin(ts, tz){const p=tzParts(ts,tz);return (Date.UTC(p.y,p.m-1,p.d,p.h,p.mi,p.s)-Math.floor(ts/1000)*1000)/60000}
/* wall-clock time (date + minutes after local midnight, may exceed 1440) in tz -> epoch ms */
function wallToUtc(y,m,d,min,tz){
  const guess=Date.UTC(y,m-1,d,0,min);
  const o1=tzOffsetMin(guess,tz); let t=guess-o1*60000;
  const o2=tzOffsetMin(t,tz); if(o2!==o1) t=guess-o2*60000;
  return t;
}
const isoOf=(y,m,d)=>`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
function addDays(y,m,d,n){const t=new Date(Date.UTC(y,m-1,d+n));return {y:t.getUTCFullYear(),m:t.getUTCMonth()+1,d:t.getUTCDate(),wd:(t.getUTCDay()+6)%7}}
/* the L2 day (date) that "now" belongs to, in tz */
function l2Today(tz){const p=tzParts(Date.now(),tz);const back=(p.h*60+p.mi)<SCH.DAY_START?-1:0;return addDays(p.y,p.m,p.d,back)}
const clock=g=>{const t=(SCH.DAY_START+g)%1440;return String(Math.floor(t/60)).padStart(2,"0")+":"+String(t%60).padStart(2,"0")};
const isAllDay=r=>r.length===1&&r[0][0]===0&&r[0][1]===1440;
const rangeTxt=r=>isAllDay(r)?"all day":r.length?r.map(([a,b])=>clock(a)+"–"+clock(b)).join(", "):"no play";
const dayLabel=(dt,tz)=>new Intl.DateTimeFormat("en-GB",{timeZone:"UTC",weekday:"short",day:"numeric",month:"short"}).format(new Date(Date.UTC(dt.y,dt.m-1,dt.d,12)));
const fmtTime=(ts,tz)=>new Intl.DateTimeFormat("en-GB",{timeZone:tz,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(ts));

/* absolute intervals [startMs, endMs) of one member around the shown week */
function memberIntervals(entry, fromMs, toMs){
  const tz=entry.tz, out=[];
  const p=tzParts(fromMs,tz); let dt=addDays(p.y,p.m,p.d,-2);
  for(let n=0;n<SCH.DAYS+5;n++,dt=addDays(dt.y,dt.m,dt.d,1)){
    const iso=isoOf(dt.y,dt.m,dt.d);
    const ranges=(entry.overrides&&iso in entry.overrides)?entry.overrides[iso]:((entry.template||{})[dt.wd]||[]);
    for(const [a,b] of ranges){
      const s=wallToUtc(dt.y,dt.m,dt.d,SCH.DAY_START+a,tz), e=wallToUtc(dt.y,dt.m,dt.d,SCH.DAY_START+b,tz);
      if(e>fromMs&&s<toMs) out.push([s,e]);
    }
  }
  return out;
}

/* ---------- server ---------- */
async function loadSched(){
  if(!API) return;
  try{
    const r=await fetch(API+"/api/schedule",{cache:"no-store",headers:{"X-Party-Key":store.get("cpKey")||""}});
    if(r.status===401){SCH.data={};$("sched-updated").textContent="Locked: type the party key at the top of the page.";renderOverlap();return}
    if(!r.ok) throw new Error(r.status);
    const d=await r.json();
    SCH.data=d.schedule||{};SCH.loaded=true;
    $("sched-updated").textContent="Updated "+new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})+" · refreshes by itself";
  }catch(e){$("sched-updated").textContent="Could not reach the server. Retrying…";return}
  if(!SCH.ed) pickEditor();
  renderOverlap();
}
async function saveSched(){
  const msg=$("sched-msg"),btn=$("sched-save");msg.className="msg";
  const who=$("sched-who").value, k=$("sched-key").value.trim();
  if(!who){msg.className="msg err";msg.textContent="Choose your name first.";return}
  if(!k){msg.className="msg err";msg.textContent="Type the party key.";return}
  if(!API){msg.className="msg err";msg.textContent="The vote server is not set up yet. Tell the party leader.";return}
  btn.disabled=true;msg.textContent="Saving…";
  try{
    const res=await fetch(API+"/api/schedule/"+encodeURIComponent(who),{method:"PUT",headers:{"Content-Type":"application/json","X-Party-Key":k},body:JSON.stringify(SCH.ed)});
    const d=await res.json().catch(()=>({}));
    if(!res.ok){msg.className="msg err";msg.textContent=d.error||`The server refused it (${res.status}).`;return}
    store.set("cpKey",k);store.set("cpName",who);
    SCH.data[key(who)]=d.entry;renderOverlap();
    msg.className="msg ok";msg.textContent=`Saved, ${who}.`;
  }catch(e){msg.className="msg err";msg.textContent="Could not reach the server. Check your connection and try again."}
  finally{btn.disabled=false}
}

/* ---------- editor ---------- */
function opt(v,t){const o=document.createElement("option");o.value=v;o.textContent=t;return o}
function fillWho(){
  const s=$("sched-who"),cur=s.value||store.get("cpName")||"";
  s.replaceChildren(opt("","Choose your name"));MEMBERS.forEach(m=>s.append(opt(m,m)));
  if(MEMBERS.includes(cur)) s.value=cur;
}
function fillTz(){
  const s=$("sched-tz");let zones=[];
  try{zones=Intl.supportedValuesOf("timeZone")}catch(e){zones=["Europe/Athens","Europe/Prague","UTC"]}
  for(const z of ["Europe/Athens","Europe/Prague",SCH.viewTz]) if(!zones.includes(z)) zones.unshift(z);
  s.replaceChildren(...zones.map(z=>opt(z,z.replace(/_/g," "))));
}
function pickEditor(){
  const who=$("sched-who").value;SCH.edWho=who;
  const have=who&&SCH.data[key(who)];
  SCH.ed=have?JSON.parse(JSON.stringify({tz:have.tz,template:have.template,overrides:have.overrides||{}})):{tz:SCH.viewTz,template:{0:[],1:[],2:[],3:[],4:[],5:[],6:[]},overrides:{}};
  $("sched-tz").value=SCH.ed.tz;
  $("sched-hint").textContent=have?"Your saved hours are loaded. Change them and save.":"New: set your usual hours per weekday, then change single days below if needed.";
  renderEditor();
}
function rangeRow(list, idx, onChange){
  const [a,b]=list[idx];
  const row=document.createElement("div");row.className="rg";
  const s1=document.createElement("select"),s2=document.createElement("select");
  s1.setAttribute("aria-label","From");s2.setAttribute("aria-label","To");
  for(let g=0;g<1440;g+=SCH.SLOT) s1.append(opt(g,clock(g)));
  for(let g=SCH.SLOT;g<=1440;g+=SCH.SLOT) s2.append(opt(g,clock(g)+(SCH.DAY_START+g>=1440?" ·night":"")));
  s1.value=a;s2.value=b;
  s1.onchange=()=>{list[idx][0]=+s1.value;if(list[idx][1]<=list[idx][0])list[idx][1]=Math.min(1440,list[idx][0]+180);onChange()};
  s2.onchange=()=>{list[idx][1]=+s2.value;if(list[idx][1]<=list[idx][0])list[idx][0]=Math.max(0,list[idx][1]-180);onChange()};
  const x=document.createElement("button");x.className="ghost sm";x.type="button";x.textContent="✕";x.title="Remove";x.setAttribute("aria-label","Remove range");
  x.onclick=()=>{list.splice(idx,1);onChange()};
  const dash=document.createElement("span");dash.textContent="–";
  row.append(s1,dash,s2,x);return row;
}
let _adId=0;
function rangesEditor(list, onChange){
  const wrap=document.createElement("div");wrap.className="rgs";
  /* "All day" tick: the whole L2 day, 06:00 -> 06:00 */
  const id="allday-"+(++_adId), lab=document.createElement("label");lab.className="check sm";lab.htmlFor=id;
  const cb=document.createElement("input");cb.type="checkbox";cb.id=id;cb.checked=isAllDay(list);
  cb.onchange=()=>{list.splice(0,list.length,...(cb.checked?[[0,1440]]:[]));onChange()};
  const t=document.createElement("span");t.textContent="All day";lab.append(cb,t);wrap.append(lab);
  if(isAllDay(list)) return wrap;
  list.forEach((_,i)=>wrap.append(rangeRow(list,i,onChange)));
  if(!list.length){const n=document.createElement("span");n.className="sub";n.textContent="no play";wrap.append(n)}
  if(list.length<4){const add=document.createElement("button");add.className="ghost sm";add.type="button";add.textContent="+ add";
    add.onclick=()=>{const last=list[list.length-1];list.push(last?[Math.min(1380,last[1]+60),Math.min(1440,last[1]+240)]:[900,1080]);onChange()};wrap.append(add)}
  return wrap;
}
function renderEditor(){
  const ed=SCH.ed;if(!ed) return;
  const tw=$("sched-week");tw.replaceChildren();
  SCH.WD.forEach((w,d)=>{
    ed.template[d]=ed.template[d]||[];
    const row=document.createElement("div");row.className="sd-row";
    const l=document.createElement("b");l.textContent=w;row.append(l,rangesEditor(ed.template[d],renderEditor));
    tw.append(row);
  });
  const ow=$("sched-days");ow.replaceChildren();
  let dt=l2Today(ed.tz);
  for(let n=0;n<SCH.DAYS;n++,dt=addDays(dt.y,dt.m,dt.d,1)){
    const iso=isoOf(dt.y,dt.m,dt.d), changed=iso in ed.overrides;
    const row=document.createElement("div");row.className="sd-row"+(changed?" changed":"");
    const l=document.createElement("b");l.textContent=dayLabel(dt);row.append(l);
    const body=document.createElement("div");body.className="sd-body";
    if(changed){
      body.append(rangesEditor(ed.overrides[iso],renderEditor));
    }else{
      const t=document.createElement("span");t.className="sub";t.textContent="weekly: "+rangeTxt(ed.template[dt.wd]||[]);body.append(t);
    }
    const acts=document.createElement("div");acts.className="sd-acts";
    const mk=(txt,fn)=>{const b=document.createElement("button");b.type="button";b.className="ghost sm";b.textContent=txt;b.onclick=fn;acts.append(b)};
    if(!changed) mk("Change this day",()=>{ed.overrides[iso]=JSON.parse(JSON.stringify(ed.template[dt.wd]||[]));renderEditor()});
    if(!isAllDay(changed?ed.overrides[iso]:(ed.template[dt.wd]||[]))) mk("All day",()=>{ed.overrides[iso]=[[0,1440]];renderEditor()});
    if(!(changed&&ed.overrides[iso].length===0)) mk("Can't play",()=>{ed.overrides[iso]=[];renderEditor()});
    if(changed) mk("Use weekly",()=>{delete ed.overrides[iso];renderEditor()});
    body.append(acts);row.append(body);ow.append(row);
  }
}

/* ---------- overlap ---------- */
function weekFrame(){
  const tz=SCH.viewTz, t0=l2Today(tz), days=[];
  let dt=t0;
  for(let n=0;n<SCH.DAYS;n++,dt=addDays(dt.y,dt.m,dt.d,1)) days.push({dt,start:wallToUtc(dt.y,dt.m,dt.d,SCH.DAY_START,tz)});
  return days;
}
function renderOverlap(){
  const out=$("sched-out");if(!out) return;
  const names=MEMBERS.filter(m=>SCH.data[key(m)]);
  const missing=MEMBERS.filter(m=>!SCH.data[key(m)]);
  $("sched-missing").textContent=missing.length?"No hours yet: "+missing.join(", "):"Everybody has entered hours.";
  const N=Math.max(1,Math.min(MEMBERS.length,+$("sched-min").value||1));
  $("sched-tzview").textContent=SCH.viewTz.replace(/_/g," ");
  if(!names.length){out.innerHTML=`<div class="box"><p class="empty">Nobody has entered hours yet. Use "My hours" above.</p></div>`;$("sched-pairs").innerHTML="";return}
  const days=weekFrame(), from=days[0].start, to=days[days.length-1].start+86400000+3*3600000;
  const iv={};names.forEach(m=>iv[m]=memberIntervals(SCH.data[key(m)],from,to));
  const avail=(m,s,e)=>iv[m].some(([a,b])=>a<=s&&b>=e);
  const pair={};names.forEach(a=>{pair[a]={};names.forEach(b=>pair[a][b]=0)});
  const ticks=[0,6,12,18,24,30,36,42];
  let html="";
  for(const day of days){
    const slots=[];
    for(let i=0;i<SCH.SLOTS;i++){
      const s=day.start+i*SCH.SLOT*60000, e=s+SCH.SLOT*60000;
      const who=names.filter(m=>avail(m,s,e));slots.push({s,e,who});
      for(const a of who) for(const b of who) if(a!==b) pair[a][b]+=SCH.SLOT/60;
    }
    /* windows: every stretch of >= 1 hour where at least N people are online.
       core = online the whole time (used for the party check), part = online for some of it */
    const best=[];let i=0;
    while(i<SCH.SLOTS){
      if(slots[i].who.length<N){i++;continue}
      let j=i;while(j+1<SCH.SLOTS&&slots[j+1].who.length>=N) j++;
      if(j-i+1>=2){
        const seg=slots.slice(i,j+1);
        const core=names.filter(m=>seg.every(x=>x.who.includes(m)));
        const part=names.filter(m=>!core.includes(m)&&seg.some(x=>x.who.includes(m))).map(m=>{
          const rs=[];let k=0;
          while(k<seg.length){if(!seg[k].who.includes(m)){k++;continue}let l=k;while(l+1<seg.length&&seg[l+1].who.includes(m))l++;rs.push([seg[k].s,seg[l].e]);k=l+1}
          return {m,rs};
        });
        const counts=seg.map(x=>x.who.length);
        best.push({s:seg[0].s,e:seg[seg.length-1].e,len:seg.length,core,part,lo:Math.min(...counts),hi:Math.max(...counts)});
      }
      i=j+1;
    }
    const anyone=slots.some(x=>x.who.length);
    const rows=names.map(m=>`<div class="tl-name">${esc(m)}</div>${slots.map(x=>`<div class="tl-c${x.who.includes(m)?" on":""}"></div>`).join("")}`).join("");
    const heat=slots.map(x=>{const n=x.who.length;const lvl=n>=N?"hot":n?"warm":"";return `<div class="tl-h ${lvl}" style="--a:${(n/MEMBERS.length).toFixed(2)}" title="${fmtTime(x.s,SCH.viewTz)} · ${n} online"></div>`}).join("");
    const head=`<div class="tl-name"></div>${Array.from({length:SCH.SLOTS},(_,k)=>`<div class="tl-t">${ticks.includes(k)?fmtTime(slots[k].s,SCH.viewTz).slice(0,2):""}</div>`).join("")}`;
    html+=`<div class="box">
      <h2>${esc(dayLabel(day.dt))}</h2>
      ${anyone?`<div class="tl-wrap"><div class="tl">${head}${rows}<div class="tl-name tl-sum">online</div>${heat}</div></div>`:`<p class="sub">Nobody can play this day.</p>`}
      ${best.length?best.map(w=>windowCard(w)).join(""):(anyone?`<p class="sub">No window with ${N}+ people for 1 hour or more.</p>`:"")}
    </div>`;
  }
  out.innerHTML=html;
  /* pair overlap */
  $("sched-pairs").innerHTML=`<table class="votes pairs"><thead><tr><th></th>${names.map(n=>`<th>${esc(n)}</th>`).join("")}</tr></thead><tbody>${
    names.map(a=>`<tr><th>${esc(a)}</th>${names.map(b=>a===b?`<td class="self">—</td>`:`<td style="--a:${Math.min(1,pair[a][b]/30).toFixed(2)}" class="pv">${fmtH(pair[a][b])}</td>`).join("")}</tr>`).join("")
  }</tbody></table>`;
}
const fmtH=h=>h?(Number.isInteger(h)?h:h.toFixed(1))+"h":"";
function windowCard(w){
  const votes=w.core.map(m=>votesById[key(m)]).filter(v=>v&&validVote(v));
  const noVote=w.core.filter(m=>!votesById[key(m)]);
  const inWin=new Set([...w.core,...w.part.map(p=>p.m)]);
  let mage="";
  if(votes.length){
    const r=solve("mage",votes);
    const own=r.lineup.filter(x=>x.who).length, rec=r.lineup.filter(x=>!x.who).map(x=>x.slot.l);
    const lineup=r.lineup.map(x=>`<li><span>${esc(x.slot.l)}</span> ${x.who?esc(x.who.name)+(x.who.cls?" · "+esc(ABBR[x.who.cls]||x.who.cls):" · volunteer"):'<b class="rec">recruit</b>'}</li>`).join("");
    mage=`<p class="sub">Mage party with the whole-time group: <b>${own}/9 own</b> · recruit: <b class="rec">${rec.length?esc(rec.join(", ")):"nobody"}</b>${r.unplaced.length?` · no slot: ${esc(r.unplaced.join(", "))}`:""}</p>
      <details><summary>Lineup</summary><ul class="wl">${lineup}</ul></details>`;
  }
  const span=(a,b)=>fmtTime(a,SCH.viewTz)+"–"+fmtTime(b,SCH.viewTz);
  const missing=MEMBERS.filter(m=>!inWin.has(m));
  return `<div class="win">
    <p class="win-h"><b>${span(w.s,w.e)}</b> · ${(w.len*SCH.SLOT/60).toString().replace(".5","½")}h · ${w.lo===w.hi?w.lo:w.lo+"–"+w.hi} of ${MEMBERS.length} online</p>
    <p class="sub">Whole time: <b>${w.core.length?esc(w.core.join(", ")):"nobody"}</b></p>
    ${w.part.length?`<p class="sub">Part of it: ${w.part.map(p=>esc(p.m)+" "+p.rs.map(r=>span(r[0],r[1])).join(", ")).join(" · ")}</p>`:""}
    ${missing.length?`<p class="sub">Not online: ${esc(missing.join(", "))}</p>`:""}
    ${mage}${noVote.length?`<p class="sub">No vote yet (not in the lineup): ${esc(noVote.join(", "))}</p>`:""}
  </div>`;
}

/* ---------- wiring ---------- */
window.schedShow=()=>{fillWho();if(!SCH.ed||SCH.edWho!==$("sched-who").value) {if(SCH.loaded) pickEditor();} loadVotes().then(loadSched)};
document.addEventListener("DOMContentLoaded",()=>{
  fillTz();fillWho();
  const k=store.get("cpKey");if(k) $("sched-key").value=k;
  const n=store.get("cpMin");$("sched-min").value=n||Math.min(6,MEMBERS.length);
  $("sched-who").addEventListener("change",()=>{store.set("cpName",$("sched-who").value);pickEditor()});
  $("sched-tz").addEventListener("change",()=>{if(SCH.ed){SCH.ed.tz=$("sched-tz").value;renderEditor()}});
  $("sched-min").addEventListener("input",()=>{store.set("cpMin",$("sched-min").value);renderOverlap()});
  $("sched-save").addEventListener("click",saveSched);
  setInterval(()=>{if(!document.hidden&&!$("view-schedule").hidden) loadSched()},30000);
});
