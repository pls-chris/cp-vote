/* CP Lineup Vote - round 2 (melee farm vs mage PvP) - Christoforos Pliatsikas */
"use strict";

let MEMBERS = []; // filled from the server after the party key is accepted (no names in public files)
let MELEE = [];   // decided melee lineup [{name, cls}], from the server
const ABBR = {"Elven Elder":"EE","Bishop":"BP","Shillien Elder":"SE","Overlord":"OL","Swordsinger":"SWS","Bladedancer":"BD",
  "Spellsinger":"SpS","Spellhowler":"SH","Sorcerer":"Sorc","Necromancer":"Necro","Warcryer":"WC","Destroyer":"Destro"};
const MAGE_SUP = ["Elven Elder","Bishop","Shillien Elder","Overlord","Swordsinger","Bladedancer"]; // one slot each
const MAGE_NUK = ["Spellsinger","Spellhowler","Sorcerer","Necromancer"];                         // 3 slots, any mix
const NUKER_SLOTS = 3;
const PARTY = {melee:"Melee farm", mage:"Mage PvP"};
const ORD = ["1st","2nd","3rd"];
const POLL_MS = 15000;
const API = String(window.CP_API||"").replace(/\/+$/,"");
const $ = id => document.getElementById(id);
const label = c => ABBR[c] ? `${c} (${ABBR[c]})` : c;
const ab = c => ABBR[c] || c;
const key = n => n.toLowerCase();
const esc = s => String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

let votesById = {};
let lastLoad = null;
const store = {
  get(k){try{return localStorage.getItem(k)}catch(e){return null}},
  set(k,v){try{localStorage.setItem(k,v)}catch(e){}}
};

/* ---------- server ---------- */
async function loadVotes(){
  if(!API){$("updated").textContent="The vote server is not set up yet (config.js has no Worker URL).";return}
  try{
    const r=await fetch(API+"/api/votes",{cache:"no-store",headers:{"X-Party-Key":store.get("cpKey")||""}});
    if(r.status===401){setLocked(true,!!store.get("cpKey"));return}
    if(!r.ok) throw new Error(r.status);
    setLocked(false);
    const d=await r.json();
    if(Array.isArray(d.members)&&d.members.length&&d.members.join()!==MEMBERS.join()){MEMBERS=d.members;fillVoters()}
    if(Array.isArray(d.melee)&&JSON.stringify(d.melee)!==JSON.stringify(MELEE)){MELEE=d.melee;renderMeleeForm()}
    votesById=d.votes||{};lastLoad=new Date();
  }catch(e){
    $("updated").textContent="Could not reach the server. Retrying…";
    return;
  }
  render();
}

/* ---------- party key gate ---------- */
function setLocked(locked,wrong){
  $("unlock").hidden=!locked;
  if(locked){
    $("unlock-msg").className="msg"+(wrong?" err":"");
    $("unlock-msg").textContent=wrong?"That party key is not right. Ask the party leader (the key changed in November 2026).":"";
    votesById={};render();
    $("results-out").innerHTML=`<div class="box"><p class="empty">Locked. Type the party key at the top of the page.</p></div>`;
    $("votes-table").innerHTML="";
  }
}
async function unlock(){
  const k=$("unlock-key").value.trim();if(!k) return;
  store.set("cpKey",k);if($("party-key")) $("party-key").value=k;if($("sched-key")) $("sched-key").value=k;
  await loadVotes();
  if(!$("unlock").hidden) return;
  if(window.schedShow&&!$("view-schedule").hidden) window.schedShow();
}

/* ---------- vote form ---------- */
function opt(v,t){const o=document.createElement("option");o.value=v;o.textContent=t;return o}
function fillVoters(){
  const voter=$("voter"),cur=voter.value;
  voter.replaceChildren(opt("","Choose your name"));
  MEMBERS.forEach(m=>voter.append(opt(m,m)));
  if(MEMBERS.includes(cur)) voter.value=cur;
  renderMyMelee();
}
function renderMeleeForm(){
  $("melee-lineup").innerHTML=MELEE.length
    ?`<ul class="wl">${MELEE.map(x=>`<li><span>${esc(ab(x.cls))}</span> ${esc(x.name)}</li>`).join("")}</ul>`
    :`<p class="sub">Unlock with the party key to see the lineup.</p>`;
  renderMyMelee();
}
function renderMyMelee(){
  const me=MELEE.find(x=>x.name===$("voter").value);
  $("my-melee").textContent=me?`Your class in the melee party: ${me.cls}.`:"";
}
function buildForm(){
  fillVoters();renderMeleeForm();
  const g=$("mage-picks");
  ["1st choice","2nd choice (optional)","3rd choice (optional)"].forEach((lab,i)=>{
    const l=document.createElement("label");l.className="f";l.htmlFor=`mage-${i}`;l.textContent=lab;
    const s=document.createElement("select");s.id=`mage-${i}`;s.append(opt("",i?"— none —":"Choose class"));
    [["Support (one slot each)",MAGE_SUP],["Nuker (3 slots, any mix)",MAGE_NUK]].forEach(([gn,cs])=>{
      const og=document.createElement("optgroup");og.label=gn;cs.forEach(c=>og.append(opt(c,label(c))));s.append(og)});
    l.append(s);g.append(l);
  });
  $("no-mage").addEventListener("change",syncNoMage);
  $("voter").addEventListener("change",()=>{
    store.set("cpName",$("voter").value);renderMyMelee();
    const v=votesById[key($("voter").value)];if(v)fillForm(v);
  });
  const k=store.get("cpKey"); if(k) $("party-key").value=k;
  const n=store.get("cpName"); if(n) $("voter").value=n;
}
function syncNoMage(){const off=$("no-mage").checked;[0,1,2].forEach(i=>$(`mage-${i}`).disabled=off)}
function fillForm(v){
  document.querySelectorAll('input[name="party"]').forEach(r=>r.checked=r.value===v.party);
  $("thoughts").value=v.thoughts||"";
  [0,1,2].forEach(i=>$(`mage-${i}`).value=(v.mage||[])[i]||"");
  $("no-mage").checked=!!v.noMage;syncNoMage();
  $("voter-hint").textContent="Your saved vote is loaded. Change it and submit again to update.";
}
function readForm(){
  const name=$("voter").value;
  if(!name) return {err:"Choose your name first."};
  const partyKey=$("party-key").value.trim();
  if(!partyKey) return {err:"Type the party key. Ask the party leader for it."};
  const p=document.querySelector('input[name="party"]:checked');
  if(!p) return {err:"Question 1: choose Melee farm or Mage PvP."};
  const noMage=$("no-mage").checked;
  const mage=noMage?[]:[0,1,2].map(i=>$(`mage-${i}`).value).filter(Boolean);
  if(!noMage&&!mage.length) return {err:"Give at least one mage choice, or tick that you won't play in the mage party."};
  if(new Set(mage).size!==mage.length) return {err:"Same class chosen twice in the mage choices."};
  return {name,partyKey,vote:{party:p.value,thoughts:$("thoughts").value.trim(),mage,noMage}};
}
function validVote(v){
  if(!v||typeof v!=="object"||!MEMBERS.includes(v.name)||!PARTY[v.party]) return false;
  if(v.noMage) return true;
  return Array.isArray(v.mage)&&v.mage.length>=1&&v.mage.length<=3&&v.mage.every(c=>MAGE_SUP.includes(c)||MAGE_NUK.includes(c));
}

async function submit(){
  const msg=$("vote-msg"),btn=$("submit");msg.className="msg";
  const r=readForm();
  if(r.err){msg.className="msg err";msg.textContent=r.err;return}
  if(!API){msg.className="msg err";msg.textContent="The vote server is not set up yet. Tell the party leader.";return}
  btn.disabled=true;msg.textContent="Saving…";
  try{
    const res=await fetch(API+"/api/votes/"+encodeURIComponent(r.name),{
      method:"PUT",headers:{"Content-Type":"application/json","X-Party-Key":r.partyKey},body:JSON.stringify(r.vote)
    });
    const d=await res.json().catch(()=>({}));
    if(!res.ok){msg.className="msg err";msg.textContent=d.error||`The server refused the vote (${res.status}).`;return}
    store.set("cpKey",r.partyKey);store.set("cpName",r.name);
    votesById[key(r.name)]=d.vote;render();
    msg.className="msg ok";msg.textContent=`Saved, ${r.name}. You can change your vote any time.`;
  }catch(e){
    msg.className="msg err";msg.textContent="Could not reach the server. Check your connection and try again.";
  }finally{btn.disabled=false}
}

/* ---------- mage lineup ---------- */
/* Every possible placement is checked. Order of priority:
   1) fewest members without a slot  2) most on their 1st choice  3) most on their 2nd choice
   4) melee voters get the better choice (a mage voter yields on a clash)  5) still equal -> agree or /dice */
function solveMage(votes){
  const ps=votes.filter(v=>validVote(v)&&!v.noMage);
  const n=ps.length, choice=new Array(n).fill(-1), top=[];
  let worst=-Infinity;
  const supUsed=new Set(); let nuk=0;
  const score=()=>{let un=0,n1=0,n2=0,me=0;
    for(let i=0;i<n;i++){const k=choice[i];if(k<0){un++;continue}if(k===0)n1++;else if(k===1)n2++;if(ps[i].party==="melee")me+=3-k}
    return {s:-un*1e6+n1*1e4+n2*100+me,un,n1,n2,me}};
  const dfs=i=>{
    if(i===n){const sc=score();if(top.length<400||sc.s>=worst){top.push({...sc,ch:choice.slice()});
      if(top.length>4000){top.sort((a,b)=>b.s-a.s);top.length=400;worst=top[top.length-1].s}}return}
    const mine=ps[i].mage;
    for(let k=0;k<mine.length;k++){
      const c=mine[k];
      if(MAGE_SUP.includes(c)){if(supUsed.has(c))continue;supUsed.add(c);choice[i]=k;dfs(i+1);supUsed.delete(c)}
      else{if(nuk>=NUKER_SLOTS)continue;nuk++;choice[i]=k;dfs(i+1);nuk--}
    }
    choice[i]=-1;dfs(i+1);
  };
  dfs(0);
  top.sort((a,b)=>b.s-a.s);
  const build=t=>{
    const sup={},nukers=[],unplaced=[];
    t.ch.forEach((k,i)=>{const v=ps[i];if(k<0){unplaced.push(v.name);return}
      const w={name:v.name,cls:v.mage[k],rank:k,party:v.party};
      if(MAGE_SUP.includes(w.cls)) sup[w.cls]=w; else nukers.push(w)});
    nukers.sort((a,b)=>MAGE_NUK.indexOf(a.cls)-MAGE_NUK.indexOf(b.cls)||a.name.localeCompare(b.name));
    const lineup=[...MAGE_SUP.map(c=>({slot:{l:ABBR[c]},who:sup[c]||null})),
      ...Array.from({length:NUKER_SLOTS},(_,j)=>({slot:{l:"Nuker"},who:nukers[j]||null}))];
    return {...t,lineup,unplaced,sig:t.ch.join(",")};
  };
  const seen=new Set(),list=[];
  for(const t of top){if(seen.has(t.ch.join(",")))continue;seen.add(t.ch.join(","));list.push(build(t))}
  const best=list.filter(x=>x.s===list[0]?.s);
  const others=list.filter(x=>x.s<(list[0]?.s??0));
  return {players:ps,best,others};
}
/* the Schedule tab asks for the mage party of a smaller group */
function solve(_comp,votes){
  const r=solveMage(votes), b=r.best[0];
  if(!b) return {lineup:[...MAGE_SUP.map(c=>({slot:{l:ABBR[c]},who:null})),...Array.from({length:NUKER_SLOTS},()=>({slot:{l:"Nuker"},who:null}))],unplaced:[]};
  return {lineup:b.lineup,unplaced:b.unplaced};
}

/* ---------- results ---------- */
function lineupTable(L,ref){
  return `<table class="lineup"><tbody>${L.lineup.map((x,j)=>{
    if(!x.who) return `<tr><td>${esc(x.slot.l)}</td><td><span class="rec">Recruit</span></td><td></td></tr>`;
    const w=x.who, diff=ref&&!(ref.lineup[j].who&&ref.lineup[j].who.name===w.name&&ref.lineup[j].who.cls===w.cls);
    return `<tr${diff?' class="diff"':""}><td>${esc(x.slot.l)}</td><td><b>${esc(w.name)}</b> · ${esc(ab(w.cls))}<br><span class="vol">${ORD[w.rank]} choice</span></td><td class="pts"><span class="pv-tag p-${w.party}">${w.party==="mage"?"voted Mage":"voted Melee"}</span></td></tr>`}).join("")}</tbody></table>`;
}
function summary(L){
  const n3=L.lineup.filter(x=>x.who&&x.who.rank===2).length, rec=L.lineup.filter(x=>!x.who).length;
  return `${L.n1} on 1st choice · ${L.n2} on 2nd · ${n3} on 3rd${rec?` · ${rec} to recruit`:""}${L.un?` · ${L.un} without a slot`:""}`;
}
function render(){
  const all=votesById; const votes=Object.values(all).filter(validVote);
  $("voted-chips").innerHTML=MEMBERS.map(m=>`<span class="chip ${all[key(m)]?"done":""}">${esc(m)}</span>`).join("");
  if(lastLoad) $("updated").textContent="Updated "+lastLoad.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"})+" · refreshes by itself";
  const out=$("results-out");
  if(!votes.length){out.innerHTML=`<div class="box"><p class="empty">No votes yet. Results show up here after the first vote.</p></div>`;$("votes-table").innerHTML=`<p class="sub">Nothing yet.</p>`;return}
  const sortM=a=>a.sort((x,y)=>MEMBERS.indexOf(x.name)-MEMBERS.indexOf(y.name));
  const by=p=>sortM(votes.filter(v=>v.party===p)).map(v=>v.name);
  const me=by("melee"), ma=by("mage");
  const lead=me.length===ma.length?"Tie so far":(me.length>ma.length?PARTY.melee:PARTY.mage);
  let html=`<div class="box winner"><p class="sub">Question 1 · ${votes.length} of ${MEMBERS.length} voted${votes.length<MEMBERS.length?" · not final yet":""}</p>
    <p class="big">${esc(lead)}${me.length!==ma.length?` · ${Math.max(me.length,ma.length)} to ${Math.min(me.length,ma.length)}`:` · ${me.length} each`}</p>
    <div class="breakdown"><span><span class="tag t-melee"></span> Melee farm <b>${me.length}</b>: ${esc(me.join(", ")||"—")}</span>
    <span><span class="tag t-mage"></span> Mage PvP <b>${ma.length}</b>: ${esc(ma.join(", ")||"—")}</span></div></div>`;

  const th=MELEE.map(x=>{const v=all[key(x.name)];return {x,t:v&&v.thoughts}});
  html+=`<div class="box card-melee"><h2><span class="tag t-melee"></span>Melee farm · decided lineup</h2>
    <table class="lineup"><tbody>${th.map(({x,t})=>`<tr><td>${esc(ab(x.cls))}</td><td><b>${esc(x.name)}</b>${t?`<br><span class="thought">${esc(t)}</span>`:""}</td></tr>`).join("")}</tbody></table>
    ${th.some(y=>y.t)?"":`<p class="sub">No second thoughts written yet.</p>`}</div>`;

  const r=solveMage(votes);
  const noMage=sortM(votes.filter(v=>v.noMage)).map(v=>v.name);
  const missing=MEMBERS.filter(m=>!all[key(m)]);
  html+=`<div class="box card-mage"><h2><span class="tag t-mage"></span>Mage PvP · suggested lineup${r.best.length>1?"s":""}</h2>
    <p class="sub">${r.players.length} members with mage choices · 6 supports (one each) + 3 nukers (any mix).</p>`;
  if(!r.best.length) html+=`<p class="empty">No mage choices yet.</p>`;
  else{
    if(r.best.length>1) html+=`<p class="note">${r.best.length} lineups are equally good by the rules. Agree between you, or <b>roll /dice</b> for the slots in gold.</p>`;
    r.best.slice(0,4).forEach((L,i)=>{html+=`<h3>${r.best.length>1?"Option "+(i+1):"Best lineup"}</h3><p class="sub">${summary(L)}</p>${lineupTable(L,i?r.best[0]:null)}
      ${L.unplaced.length?`<p class="note">No slot from their choices: ${esc(L.unplaced.join(", "))}</p>`:""}`});
    if(r.best.length>4) html+=`<p class="sub">+${r.best.length-4} more equal lineups.</p>`;
    const alt=r.others.slice(0,2);
    if(alt.length) html+=`<details><summary>Next best lineups (${alt.length})</summary>${alt.map((L,i)=>`<h3>Alternative ${i+1}</h3><p class="sub">${summary(L)}</p>${lineupTable(L,r.best[0])}${L.unplaced.length?`<p class="note">No slot: ${esc(L.unplaced.join(", "))}</p>`:""}`).join("")}</details>`;
  }
  if(noMage.length) html+=`<p class="note">Won't play in the mage party: ${esc(noMage.join(", "))}. Their places are recruits if we go mage.</p>`;
  if(missing.length) html+=`<p class="sub">Not voted yet: ${esc(missing.join(", "))}</p>`;
  html+=`</div>`;
  out.innerHTML=html;

  $("votes-table").innerHTML=`<table class="votes"><thead><tr><th>Member</th><th>Question 1</th><th>Mage choices</th><th>Second thoughts</th></tr></thead><tbody>${
    sortM(votes.slice()).map(v=>`<tr><td><b>${esc(v.name)}</b></td><td>${esc(PARTY[v.party])}</td><td>${v.noMage?`<span class="neg">won't play mage</span>`:esc(v.mage.map(ab).join(" › "))}</td><td>${v.thoughts?esc(v.thoughts):"—"}</td></tr>`).join("")
  }</tbody></table>`;
}

/* ---------- tabs ---------- */
const VIEWS=["vote","results","schedule","rules"];
function show(which){
  if(!VIEWS.includes(which)) which="vote";
  VIEWS.forEach(v=>{$("tab-"+v).setAttribute("aria-selected",v===which);$("view-"+v).hidden=v!==which});
  if(which==="results") loadVotes();
  if(which==="schedule"&&window.schedShow) window.schedShow();
  store.set("cpTab",which);
}

document.addEventListener("DOMContentLoaded",()=>{
  VIEWS.forEach(v=>$("tab-"+v).addEventListener("click",()=>show(v)));
  $("goto-rules").addEventListener("click",()=>{show("rules");window.scrollTo(0,0)});
  $("submit").addEventListener("click",submit);
  $("unlock-btn").addEventListener("click",unlock);
  $("unlock-key").addEventListener("keydown",e=>{if(e.key==="Enter")unlock()});
  buildForm();render();
  const hash=location.hash.slice(1);
  show(VIEWS.includes(hash)?hash:(store.get("cpTab")||"vote"));
  loadVotes().then(()=>{const n=$("voter").value;if(n&&votesById[key(n)])fillForm(votesById[key(n)])});
  setInterval(()=>{if(!document.hidden)loadVotes()},POLL_MS);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)loadVotes()});
});
