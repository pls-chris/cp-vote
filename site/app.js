/* CP Lineup Vote - Christoforos Pliatsikas */
"use strict";

let MEMBERS = ["kOsA","Ankalime","turambar","morrax","sinook","gx","morgx"]; // replaced by the server list
const TYPES = [{id:"mage",name:"Mage"},{id:"melee",name:"Melee"},{id:"archer",name:"Archer"}];
const ABBR = {"Bladedancer":"BD","Swordsinger":"SWS","Overlord":"OL","Bishop":"BP","Elven Elder":"EE","Shillien Elder":"SE","Warcryer":"WC","Prophet":"PP"};
const SUPPORTS = Object.keys(ABBR);
const GROUPS = {
  buff:{name:"buffer",cls:["Warcryer","Prophet","Shillien Elder","Overlord"]},
  bard:{name:"bard",cls:["Swordsinger","Bladedancer"]},
  heal:{name:"healer",cls:["Elven Elder","Bishop"]}
};
const NUKERS = ["Sorcerer","Necromancer","Spellsinger","Spellhowler"];
const MAGE_NUKERS = ["Sorcerer","Spellsinger","Spellhowler"]; // Necro has its own slot
const ARCHERS = ["Hawkeye","Silver Ranger","Phantom Ranger"];
const TANKS = ["Paladin","Dark Avenger","Temple Knight","Shillien Knight"];
const DDS = ["Gladiator","Warlord","Treasure Hunter","Plains Walker","Abyss Walker","Destroyer","Tyrant","Warlock","Elemental Summoner","Phantom Summoner","Bounty Hunter","Warsmith"];
const S = (l,a,extra={}) => Object.assign({l,a,s:a.every(c=>SUPPORTS.includes(c))},extra);
const WCPP = S("WC / PP",["Warcryer","Prophet"],{b:{"Warcryer":0.5}});
const COMPS = {
  mage:[S("Necro",["Necromancer"]),S("Nuker",MAGE_NUKERS),S("Nuker",MAGE_NUKERS),S("BD",["Bladedancer"]),S("SWS",["Swordsinger"]),S("OL",["Overlord"]),S("BP",["Bishop"]),S("EE",["Elven Elder"]),S("SE",["Shillien Elder"])],
  archer:[S("Archer",ARCHERS),S("Archer",ARCHERS),S("Archer",ARCHERS),S("BD",["Bladedancer"]),S("SWS",["Swordsinger"]),S("EE",["Elven Elder"]),S("BP",["Bishop"]),WCPP,S("Archer / Warlock / Tank",[...ARCHERS,"Warlock",...TANKS],{note:{cls:TANKS,text:"tank must sub Warlock"}})],
  melee:[S("BD",["Bladedancer"]),S("SWS",["Swordsinger"]),S("BP",["Bishop"]),WCPP,S("SE / EE",["Shillien Elder","Elven Elder"]),S("Tank",TANKS),S("DD",DDS),S("DD",DDS),S("DD",DDS)]
};
const COMP_TEXT = {
  mage:"Necro · 2 Nuker (Sorc, SpS, SH) · BD · SWS · OL · BP · EE · SE",
  archer:"3 Archer · BD · SWS · EE · BP · WC/PP · Archer / Warlock / Tank (a tank in this slot must sub Warlock)",
  melee:"BD · SWS · BP · WC/PP · SE/EE · Tank · 3 DD (summoner, spoiler, crafter OK)"
};
const PICK_PTS=[3,2,1], TYPE_PTS=[3,2,1], GAP=3, UNPLACED=5;
/* lineup priority: 1) fewest members without a slot  2) most members on a top pick  3) highest points */
const PRIO_SLOT=10000, PRIO_TOP=100;
const ORD=["1st","2nd","3rd"];
const POLL_MS=15000;
const API=String(window.CP_API||"").replace(/\/+$/,"");
const $ = id => document.getElementById(id);
const label = c => ABBR[c] ? `${c} (${ABBR[c]})` : c;
const key = n => n.toLowerCase();

let votesById = {};
let lastLoad = null;

const VOL_KEYS=["buff","bard","heal"];
const volOf = (v,comp) => {
  const x=v.vol||{};
  if(x[comp]&&typeof x[comp]==="object") return x[comp];          // per party type
  if(VOL_KEYS.some(k=>k in x)) return x;                             // older votes: one set for all types
  return v.support?{buff:true,bard:true,heal:true}:{};
};
const eqOf = (v,comp) => !!(v.eq&&v.eq[comp]);  // "1st = 2nd" box
const volClasses = (v,comp) => {const g=volOf(v,comp);return Object.keys(GROUPS).filter(k=>g[k]).flatMap(k=>GROUPS[k].cls)};
const store = {
  get(k){try{return localStorage.getItem(k)}catch(e){return null}},
  set(k,v){try{localStorage.setItem(k,v)}catch(e){}}
};

/* ---------- server ---------- */
async function loadVotes(){
  if(!API){$("updated").textContent="The vote server is not set up yet (config.js has no Worker URL).";return}
  try{
    const r=await fetch(API+"/api/votes",{cache:"no-store"});
    if(!r.ok) throw new Error(r.status);
    const d=await r.json();
    if(Array.isArray(d.members)&&d.members.length&&d.members.join()!==MEMBERS.join()){MEMBERS=d.members;fillVoters()}
    votesById=d.votes||{};lastLoad=new Date();
  }catch(e){
    $("updated").textContent="Could not reach the server. Retrying…";
    return;
  }
  render();
}

/* ---------- vote form ---------- */
function opt(v,t){const o=document.createElement("option");o.value=v;o.textContent=t;return o}
function fillVoters(){
  const voter=$("voter"),cur=voter.value;
  voter.replaceChildren(opt("","Choose your name"));
  MEMBERS.forEach(m=>voter.append(opt(m,m)));
  if(MEMBERS.includes(cur)) voter.value=cur;
}
function buildForm(){
  fillVoters();
  [0,1,2].forEach(i=>{const s=$("rank"+i);s.append(opt("","—"));TYPES.forEach(t=>s.append(opt(t.id,t.name)));});
  const wrap=$("comp-boxes");
  TYPES.forEach(t=>{
    const valid=[...new Set(COMPS[t.id].flatMap(s=>s.a))];
    const groups=[["Support",valid.filter(c=>SUPPORTS.includes(c))],["Nuker",valid.filter(c=>NUKERS.includes(c))],["Archer",valid.filter(c=>ARCHERS.includes(c))],["Tank",valid.filter(c=>TANKS.includes(c))],["DD / Summoner / Dwarf",valid.filter(c=>DDS.includes(c))]].filter(g=>g[1].length);
    const box=document.createElement("div");box.className="box";
    box.innerHTML=`<h2><span class="tag t-${t.id}"></span>If we go ${t.name}</h2><p class="slots">${COMP_TEXT[t.id]}</p><div class="grid3"></div>
      <label class="check" for="eq-${t.id}"><input type="checkbox" id="eq-${t.id}"><span>My <b>1st and 2nd pick are equal</b> for me. Put me where the party needs me more.</span></label>
      <p class="sub">Support if needed in ${t.name}:</p>
      <div class="checks">${VOL_KEYS.map(k=>`<label class="check" for="vol-${t.id}-${k}"><input type="checkbox" id="vol-${t.id}-${k}"><span>I'm ok playing <b>${GROUPS[k].name}</b> <small>(${GROUPS[k].cls.filter(c=>COMPS[t.id].some(s=>s.a.includes(c))).map(c=>ABBR[c]).join(", ")})</small></span></label>`).join("")}</div>`;
    const g=box.querySelector(".grid3");
    ["1st pick","2nd pick","3rd pick (optional)"].forEach((lab,i)=>{
      const l=document.createElement("label");l.className="f";l.htmlFor=`pick-${t.id}-${i}`;l.textContent=lab;
      const s=document.createElement("select");s.id=`pick-${t.id}-${i}`;s.append(opt("",i<2?"Choose class":"— none —"));
      groups.forEach(([gn,cs])=>{const og=document.createElement("optgroup");og.label=gn;cs.forEach(c=>og.append(opt(c,label(c))));s.append(og)});
      l.append(s);g.append(l);
    });
    wrap.append(box);
  });
  $("voter").addEventListener("change",()=>{
    store.set("cpName",$("voter").value);
    const v=votesById[key($("voter").value)];if(v)fillForm(v);
  });
  const k=store.get("cpKey"); if(k) $("party-key").value=k;
  const n=store.get("cpName"); if(n&&MEMBERS.includes(n)) $("voter").value=n;
}
function fillForm(v){
  v.rank.forEach((r,i)=>$("rank"+i).value=r);
  TYPES.forEach(t=>[0,1,2].forEach(i=>$(`pick-${t.id}-${i}`).value=(v.picks[t.id]||[])[i]||""));
  TYPES.forEach(t=>{const g=volOf(v,t.id);VOL_KEYS.forEach(k=>$(`vol-${t.id}-${k}`).checked=!!g[k]);$(`eq-${t.id}`).checked=eqOf(v,t.id)});
  $("voter-hint").textContent="Your saved vote is loaded. Change it and submit again to update.";
}
function readForm(){
  const name=$("voter").value;
  if(!name) return {err:"Choose your name first."};
  const partyKey=$("party-key").value.trim();
  if(!partyKey) return {err:"Type the party key. Ask the party leader for it."};
  const rank=[0,1,2].map(i=>$("rank"+i).value);
  if(rank.some(r=>!r)||new Set(rank).size!==3) return {err:"Rank all three party types, each one once."};
  const picks={};
  for(const t of TYPES){
    const p=[0,1,2].map(i=>$(`pick-${t.id}-${i}`).value).filter(Boolean);
    if(p.length<2) return {err:`Give at least 2 class picks for ${t.name}.`};
    if(new Set(p).size!==p.length) return {err:`Same class picked twice for ${t.name}.`};
    picks[t.id]=p;
  }
  const vol={};TYPES.forEach(t=>{vol[t.id]={};VOL_KEYS.forEach(k=>vol[t.id][k]=$(`vol-${t.id}-${k}`).checked)});
  const eq={};TYPES.forEach(t=>eq[t.id]=$(`eq-${t.id}`).checked);
  return {name,partyKey,vote:{rank,picks,vol,eq}};
}
function validVote(v){
  if(!v||typeof v!=="object"||!MEMBERS.includes(v.name)) return false;
  if(!Array.isArray(v.rank)||v.rank.length!==3||!TYPES.every(t=>v.rank.includes(t.id))) return false;
  if(!v.picks) return false;
  return TYPES.every(t=>{const p=v.picks[t.id];const ok=new Set(COMPS[t.id].flatMap(s=>s.a));return Array.isArray(p)&&p.length>=1&&p.length<=3&&p.every(c=>ok.has(c))});
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

/* ---------- scoring ---------- */
function solve(comp,votes){
  const slots=COMPS[comp];
  const supIdx=slots.map((s,j)=>s.s?j:-1).filter(j=>j>=0);
  const tp=v=>TYPE_PTS[v.rank.indexOf(comp)];
  const opts=votes.map(v=>{
    const o=[];
    const eq=eqOf(v,comp);
    (v.picks[comp]||[]).forEach((cls,k)=>{
      const eff=(eq&&k===1)?0:k;               // with "1st = 2nd" the 2nd pick counts as a 1st pick
      slots.forEach((s,j)=>{if(s.a.includes(cls))o.push({j,cls,rank:k,eff,top:eff===0,pts:PICK_PTS[eff]+((s.b&&s.b[cls])||0)})});
    });
    const vc=volClasses(v,comp);
    supIdx.forEach(j=>{if(slots[j].a.some(c=>vc.includes(c))&&!o.some(x=>x.j===j))o.push({j,cls:null,rank:-1,eff:3,top:false,pts:0,vol:true})});
    return o;
  });
  const memo=new Map();
  const f=(i,mask)=>{
    const mk=i*1024+mask; if(memo.has(mk)) return memo.get(mk);
    let res;
    if(i===votes.length){res={val:-GAP*supIdx.filter(j=>!(mask&(1<<j))).length,ch:[]}}
    else{
      const nx=f(i+1,mask); res={val:nx.val-UNPLACED-PRIO_SLOT,ch:[null,...nx.ch]};
      for(const o of opts[i]){
        if(mask&(1<<o.j)) continue;
        /* PRIO_TOP protects top picks; the 0.001 part is only a tie-break (max 0.081, never beats a real 0.5 point):
           better picks go to whoever ranked this party type higher */
        const r=f(i+1,mask|(1<<o.j)); const val=r.val+o.pts+(o.top?PRIO_TOP:0)+0.001*tp(votes[i])*(o.vol?0.5:3-o.eff);
        if(val>res.val+1e-9) res={val,ch:[o,...r.ch]};
      }
    }
    memo.set(mk,res);return res;
  };
  const best=f(0,0);
  const lineup=slots.map(s=>({slot:s,who:null}));
  let classPts=0,unplaced=[];const unplacedIdx=[];
  best.ch.forEach((o,i)=>{if(o){lineup[o.j].who={name:votes[i].name,vote:votes[i],i,...o};classPts+=o.pts}else{unplaced.push(votes[i].name);unplacedIdx.push(i)}});
  /* full ties: two members could swap slots with the same points and the same party type rank -> settle with /dice */
  const bestOpt=(i,j)=>opts[i].filter(o=>o.j===j&&!o.vol).sort((a,b)=>(b.top-a.top)||(b.pts-a.pts))[0];
  for(let j1=0;j1<lineup.length;j1++) for(let j2=j1+1;j2<lineup.length;j2++){
    const A=lineup[j1].who,B=lineup[j2].who;
    if(!A||!B||A.vol||B.vol||lineup[j1].slot.l===lineup[j2].slot.l) continue;
    if(tp(A.vote)!==tp(B.vote)) continue;
    const oa=bestOpt(A.i,j2),ob=bestOpt(B.i,j1);
    if(oa&&ob&&oa.top+ob.top===A.top+B.top&&Math.abs(oa.pts+ob.pts-A.pts-B.pts)<1e-9){
      (A.dice=A.dice||[]).push(B.name);(B.dice=B.dice||[]).push(A.name);
    }
  }
  const unplacedTies=[];
  unplacedIdx.forEach(u=>lineup.forEach((x,j)=>{
    const A=x.who; if(!A||A.vol||tp(A.vote)!==tp(votes[u])) return;
    const ou=bestOpt(u,j);
    if(ou&&ou.top===A.top&&Math.abs(ou.pts-A.pts)<1e-9){(A.dice=A.dice||[]).push(votes[u].name);unplacedTies.push(`${votes[u].name} vs ${A.name} for ${x.slot.l}`)}
  }));
  lineup.forEach(x=>{
    if(!x.who||!x.who.vol) return;
    const vc=volClasses(x.who.vote,comp);
    const pool=new Set();
    lineup.forEach(y=>{if(y.slot.s&&(!y.who||y.who.vol))y.slot.a.forEach(c=>{if(vc.includes(c))pool.add(c)})});
    x.who.choices=[...pool].map(c=>ABBR[c]);
    x.who.groupName=Object.keys(GROUPS).filter(k=>volOf(x.who.vote,comp)[k]&&x.slot.a.some(c=>GROUPS[k].cls.includes(c))).map(k=>GROUPS[k].name).join(" / ");
  });
  const gaps=lineup.filter(x=>!x.who&&x.slot.s).length;
  const typePts=votes.reduce((a,v)=>a+tp(v),0);
  return {comp,lineup,classPts,gaps,unplaced,unplacedTies,typePts,total:typePts+classPts-GAP*gaps-UNPLACED*unplaced.length};
}
const fmt=n=>Number.isInteger(n)?String(n):n.toFixed(1);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function render(){
  const all=votesById; const votes=Object.values(all).filter(validVote);
  $("voted-chips").innerHTML=MEMBERS.map(m=>`<span class="chip ${all[key(m)]?"done":""}">${esc(m)}</span>`).join("");
  if(lastLoad) $("updated").textContent="Updated "+lastLoad.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"})+" · refreshes by itself";
  const out=$("results-out");
  if(!votes.length){out.innerHTML=`<div class="box"><p class="empty">No votes yet. The scores and lineups show up here after the first vote.</p></div>`;$("votes-table").innerHTML=`<p class="sub">Nothing yet.</p>`;return}
  const res=TYPES.map(t=>solve(t.id,votes)).sort((a,b)=>b.total-a.total||a.gaps-b.gaps||b.typePts-a.typePts);
  const name=id=>TYPES.find(t=>t.id===id).name;
  const top=res[0];
  const recruits=top.lineup.filter(x=>!x.who).map(x=>x.slot.l);
  const same=(a,b)=>Math.abs(a-b)<1e-9;
  const sameTotal=res.filter(r=>same(r.total,top.total));
  const fullTie=sameTotal.filter(r=>r.gaps===top.gaps&&same(r.typePts,top.typePts));
  let headline=name(top.comp)+" party", why="";
  if(fullTie.length>1) headline="Tie: "+fullTie.map(r=>name(r.comp)).join(" / ");
  else if(sameTotal.length>1) why=sameTotal.some(r=>r!==top&&r.gaps!==top.gaps)
    ?`Same total as ${sameTotal.filter(r=>r!==top).map(r=>name(r.comp)).join(" / ")}, wins the tie-break with fewer support gaps.`
    :`Same total as ${sameTotal.filter(r=>r!==top).map(r=>name(r.comp)).join(" / ")}, wins the tie-break with more party type votes.`;
  let html=`<div class="box winner"><p class="sub">${votes.length} of ${MEMBERS.length} voted${votes.length<MEMBERS.length?" · not final yet":""}</p>
    <p class="big">${headline} · ${fmt(top.total)} pts</p>${why?`<p class="sub">${why}</p>`:""}
    <p class="sub">Recruit: <b class="rec">${recruits.length?esc(recruits.join(", ")):"nobody"}</b></p></div>`;
  html+=res.map((r,i)=>`<div class="box card-${r.comp}">
    <div class="score"><h2><span class="tag t-${r.comp}"></span>${i+1}. ${name(r.comp)}</h2><span class="tot">${fmt(r.total)}</span></div>
    <div class="breakdown"><span>Type vote <b>${fmt(r.typePts)}</b></span><span>Class picks <b>${fmt(r.classPts)}</b></span>
      <span class="${r.gaps?"neg":""}">Support gaps <b>${r.gaps?"−"+GAP*r.gaps:"0"}</b></span>
      ${r.unplaced.length?`<span class="neg">Unplaced <b>−${UNPLACED*r.unplaced.length}</b></span>`:""}</div>
    <table class="lineup"><tbody>${r.lineup.map(x=>{
      if(!x.who) return `<tr><td>${esc(x.slot.l)}</td><td><span class="rec ${x.slot.s?"sup":""}">Recruit</span></td><td class="pts"></td></tr>`;
      const w=x.who;
      const what=w.vol
        ?`<span class="vol">volunteer ${esc(w.groupName)} · chooses from: ${esc(w.choices.join(", "))}</span>`
        :`${esc(label(w.cls))} · <span class="vol">${ORD[w.rank]} pick${w.rank===1&&w.eff===0?" (= 1st)":""}</span>`;
      const slotLabel=w.vol?"Support":x.slot.l;
      const note=(!w.vol&&x.slot.note&&x.slot.note.cls.includes(w.cls))?`<br><span class="dice">${esc(x.slot.note.text)}</span>`:"";
      const dice=w.dice?`<br><span class="dice">tie with ${esc(w.dice.join(", "))} · roll /dice for this slot</span>`:"";
      return `<tr><td>${esc(slotLabel)}</td><td><b>${esc(w.name)}</b><br>${what}${note}${dice}</td><td class="pts">+${fmt(w.pts)}</td></tr>`}).join("")}</tbody></table>
    ${r.unplaced.length?`<p class="note">No slot from their picks: ${esc(r.unplaced.join(", "))}</p>`:""}
    ${r.unplacedTies.length?`<p class="note">Tie, roll /dice: ${esc(r.unplacedTies.join("; "))}</p>`:""}
    ${r.lineup.some(x=>x.who&&x.who.vol)?`<p class="sub">The empty support slots change depending on the class the volunteer chooses.</p>`:""}
  </div>`).join("");
  out.innerHTML=html;
  const pickTxt=(v,c)=>{const p=v.picks[c].map(x=>esc(ABBR[x]||x));return eqOf(v,c)&&p.length>1?p[0]+" = "+p[1]+(p[2]?", "+p[2]:""):p.join(", ")};
  const volTxt=(v,c)=>{const g=volOf(v,c);const t=VOL_KEYS.filter(k=>g[k]).map(k=>GROUPS[k].name);return t.length?`<br><span class="vol">+ ${esc(t.join(", "))}</span>`:""};
  $("votes-table").innerHTML=`<table class="votes"><thead><tr><th>Member</th><th>Type order</th><th>Mage</th><th>Melee</th><th>Archer</th></tr></thead><tbody>${
    votes.sort((a,b)=>MEMBERS.indexOf(a.name)-MEMBERS.indexOf(b.name)).map(v=>`<tr><td><b>${esc(v.name)}</b></td><td>${v.rank.map(name).join(" › ")}</td>${["mage","melee","archer"].map(c=>`<td>${pickTxt(v,c)}${volTxt(v,c)}</td>`).join("")}</tr>`).join("")
  }</tbody></table>`;
}

/* ---------- tabs ---------- */
const VIEWS=["vote","results","rules"];
function show(which){
  if(!VIEWS.includes(which)) which="vote";
  VIEWS.forEach(v=>{$("tab-"+v).setAttribute("aria-selected",v===which);$("view-"+v).hidden=v!==which});
  if(which==="results") loadVotes();
  store.set("cpTab",which);
}

document.addEventListener("DOMContentLoaded",()=>{
  VIEWS.forEach(v=>$("tab-"+v).addEventListener("click",()=>show(v)));
  $("goto-rules").addEventListener("click",()=>{show("rules");window.scrollTo(0,0)});
  $("submit").addEventListener("click",submit);
  buildForm();render();
  const hash=location.hash.slice(1);
  show(VIEWS.includes(hash)?hash:(store.get("cpTab")||"vote"));
  loadVotes().then(()=>{const n=$("voter").value;if(n&&votesById[key(n)])fillForm(votesById[key(n)])});
  setInterval(()=>{if(!document.hidden)loadVotes()},POLL_MS);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)loadVotes()});
});
