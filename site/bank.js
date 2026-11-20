/* CP bank tab - Christoforos Pliatsikas
   Read: party key (whole CP). Write: admin key only (checked by the Worker on every change).
   Everything shown (balance, warehouse, given/received, goal progress) is computed here from the ledger. */
"use strict";
(() => {
const B = {data:null, items:null, byId:new Map(), admin:false, filter:{member:"",type:""}, loading:false};
const TYPES = {
  deposit:{l:"Deposit",  d:"a member gives adena and/or an item to the CP"},
  income: {l:"Party income", d:"drops / spoil / quest reward that goes straight into the bank"},
  purchase:{l:"Purchase", d:"the CP pays adena for gear for a member"},
  handout:{l:"Hand-out", d:"an item from the warehouse goes to a member"},
  sale:   {l:"Sale",     d:"an item from the warehouse is sold for adena"},
  expense:{l:"General expense", d:"adena the CP spends for nobody in particular: shots, scrolls, misc. The note is optional"},
  adjust: {l:"Correction", d:"fix the adena balance (+ or −), with a note why"},
};
const GR = ["D","C","B","A","S"];
const fmt = n => Math.round(n).toLocaleString("en");
const short = n => {const a=Math.abs(n),s=n<0?"−":"";
  if(a>=1e9) return s+(a/1e9).toFixed(a>=1e10?1:2).replace(/\.?0+$/,"")+"B";
  if(a>=1e6) return s+(a/1e6).toFixed(a>=1e7?1:2).replace(/\.?0+$/,"")+"M";
  if(a>=1e4) return s+Math.round(a/1e3)+"k"; return s+fmt(a)};
const A = n => `<span class="ad" title="${fmt(n)} adena">${short(n)}</span>`;
const today = () => new Date(Date.now()-new Date().getTimezoneOffset()*6e4).toISOString().slice(0,10);
/* "1.5m", "200k", "2kk", "1,500,000" -> number */
function parseAdena(t){
  t=String(t||"").trim().toLowerCase().replace(/[\s,_']/g,"").replace(/kk/g,"m");
  if(!t) return 0;
  const m=t.match(/^([+\-\u2212]?)(\d+(?:\.\d+)?)([kmb]?)$/); if(!m) return NaN;
  const v=parseFloat(m[2])*({"":1,k:1e3,m:1e6,b:1e9}[m[3]]);
  return Math.round(m[1]==="-"||m[1]==="\u2212"?-v:v);
}
const S = () => B.data.settings;
const mid = g => {const r=S().crystal[g]||[0,0];return (r[0]+r[1])/2};
/* value hints for an item: D+ crystal value (range), NG what an NPC pays (half the base price) */
function hint(it, qty=1){
  if(!it) return null;
  if(it.cat==="crystal"){const r=S().crystal[it.grade]||[0,0];return {lo:r[0]*qty,hi:r[1]*qty,how:`${it.grade} crystal price`}}
  if(it.cc>0&&it.grade!=="NG"){const r=S().crystal[it.grade]||[0,0];return {lo:it.cc*r[0]*qty,hi:it.cc*r[1]*qty,how:`${fmt(it.cc)} ${it.grade} crystals`}}
  return {lo:Math.floor(it.price/2)*qty,hi:Math.floor(it.price/2)*qty,how:"NPC buys at ½ base price"};
}
const shopPrice = it => Math.round(it.price*(1+(S().tax||0)/100));
const itemOf = x => x&&x.id?B.byId.get(x.id):null;

/* ---------- server ---------- */
async function load(){
  if(!API||B.loading) return; B.loading=true;
  const h={"X-Party-Key":store.get("cpKey")||""}; const ak=store.get("cpAdmin"); if(ak) h["X-Admin-Key"]=ak;
  try{
    const [r]=await Promise.all([fetch(API+"/api/bank",{cache:"no-store",headers:h}), loadItems()]);
    if(r.status===401){B.data=null;setLocked(true,!!store.get("cpKey"));render();return}
    if(!r.ok) throw new Error(r.status);
    setLocked(false);
    const d=await r.json(); B.data=d.bank; B.admin=!!d.admin;
    if(d.admin&&$("admin-msg").classList.contains("err")) $("admin-msg").textContent="";
    if(ak&&!d.admin){store.set("cpAdmin","");msg("admin-msg","That admin key is not right.",true)}
    if(Array.isArray(d.members)&&d.members.length) MEMBERS=d.members;
    render();
  }catch(e){ $("bank-status").textContent="Could not reach the server. Retrying…" }
  finally{B.loading=false}
}
async function loadItems(){
  if(B.items) return;
  const r=await fetch("items.json",{cache:"force-cache"}); const j=await r.json();
  B.items=j.items.map(([id,name,cat,sub,grade,price,cc])=>({id,name,cat,sub,grade,price,cc}));
  B.items.forEach(i=>B.byId.set(i.id,i));
  $("item-names").innerHTML=B.items.map(i=>`<option value="${esc(i.name)}">${esc(i.grade+" · "+i.sub)}</option>`).join("");
}
async function op(body){
  const r=await fetch(API+"/api/bank",{method:"POST",headers:{"Content-Type":"application/json","X-Admin-Key":store.get("cpAdmin")||""},body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error||`The server refused it (${r.status}).`);
  return d.result;
}
function msg(id,t,bad){const m=$(id);if(!m)return;m.className="msg "+(bad?"err":"ok");m.textContent=t}

/* ---------- derived state ---------- */
function compute(){
  const live=B.data.entries.filter(e=>!e.void).sort((a,b)=>a.date.localeCompare(b.date)||a.created-b.created);
  let bal=0,income=0,expenses=0; const per={}, stock=new Map(), series=[];
  MEMBERS.forEach(m=>per[m]={given:0,gA:0,gI:0,recv:0,last:""});
  const P=m=>per[m]||(per[m]={given:0,gA:0,gI:0,recv:0,last:""});
  const sk=it=>it.id?"#"+it.id:"n:"+it.name.toLowerCase();
  const addStock=(it,sign)=>{const k=sk(it);const s=stock.get(k)||{item:{id:it.id,name:it.name},qty:0,value:0};
    if(sign>0){s.qty+=it.qty;s.value+=it.value}else{const avg=s.qty?s.value/s.qty:0;s.qty-=it.qty;s.value=Math.max(0,s.value-avg*it.qty)}
    stock.set(k,s)};
  for(const e of live){
    const a=e.adena||0;
    if(e.type==="deposit"){bal+=a;const p=P(e.member);p.gA+=a;if(e.item){p.gI+=e.item.value;addStock(e.item,1)}p.given=p.gA+p.gI;p.last=e.date}
    else if(e.type==="income"){bal+=a;income+=a+(e.item?e.item.value:0);if(e.item)addStock(e.item,1)}
    else if(e.type==="purchase"){bal-=a;const p=P(e.member);p.recv+=a;p.last=e.date}
    else if(e.type==="handout"){const p=P(e.member);p.recv+=e.item.value;addStock(e.item,-1);p.last=e.date}
    else if(e.type==="sale"){bal+=a;addStock(e.item,-1)}
    else if(e.type==="expense"){bal-=a;expenses+=a}
    else if(e.type==="adjust"){bal+=a}
    const L=series[series.length-1]; if(L&&L[0]===e.date)L[1]=bal; else series.push([e.date,bal]);
  }
  const wh=[...stock.values()].filter(s=>s.qty>0).map(s=>{const it=itemOf(s.item);const h=hint(it,s.qty);
    return {...s,it,lo:h?h.lo:s.value,hi:h?h.hi:s.value}}).sort((a,b)=>b.hi-a.hi);
  const whLo=wh.reduce((t,s)=>t+s.lo,0), whHi=wh.reduce((t,s)=>t+s.hi,0);
  const open=B.data.goals.filter(g=>g.status==="open").sort((a,b)=>a.priority-b.priority||a.created-b.created);
  let left=Math.max(0,bal), leftStock=Math.max(0,bal)+whLo;
  const goals=open.map(g=>{const f=Math.min(g.cost,left);left-=f;const fs=Math.min(g.cost,leftStock);leftStock-=fs;
    return {...g,funded:f,missing:g.cost-f,pct:g.cost?f/g.cost:0,pctStock:g.cost?fs/g.cost:0}});
  return {bal,income,expenses,per,wh,whLo,whHi,goals,series,live};
}

/* ---------- render ---------- */
function render(){
  const v=$("view-bank"); if(!v||v.hidden) return;
  $("bank-admin-tools").hidden=!B.admin; $("bank-admin-state").textContent=B.admin?"Editing is on in this browser.":"Read only.";
  $("admin-lock").hidden=!B.admin; $("admin-key-row").hidden=B.admin;
  if(!B.data){$("bank-out").innerHTML=`<div class="box"><p class="empty">Locked. Type the party key at the top of the page.</p></div>`;return}
  if(!B.items) return;
  const c=compute(); B.c=c;
  $("bank-status").textContent=`${c.live.length} ledger lines · crystal prices ${GR.filter(g=>S().crystal[g][1]).map(g=>`${g} ${fmt(S().crystal[g][0])}–${fmt(S().crystal[g][1])}`).join(", ")||"not set"} · shop tax ${S().tax||0}%`;
  const next=c.goals[0];
  let h=`<div class="kpis">
    <div class="kpi"><span>Bank adena</span><b>${A(c.bal)}</b></div>
    <div class="kpi"><span>Warehouse items</span><b>${c.whLo===c.whHi?A(c.whLo):`${A(c.whLo)}–${A(c.whHi)}`}</b><small>${c.wh.length} kinds</small></div>
    <div class="kpi"><span>Total value</span><b>${A(c.bal+c.whLo)}${c.whHi>c.whLo?`<small>–${short(c.bal+c.whHi)}</small>`:""}</b></div>
    <div class="kpi"><span>Party income</span><b>${A(c.income)}</b><small>drops & spoil</small></div>
    <div class="kpi"><span>General expenses</span><b>${A(c.expenses)}</b><small>shots, misc</small></div>
  </div>`;
  if(next) h+=`<div class="box winner"><p class="sub">Next goal${next.member?` · for ${esc(next.member)}`:""}</p>
    <p class="big">${esc(next.title)}</p>${bar(next)}
    <p class="sub">${next.missing?`We have ${A(next.funded)} of ${A(next.cost)}, missing <b>${A(next.missing)}</b>.`:`<b>Fully covered</b> by the bank adena.`}${pace(next.missing,c)}</p></div>`;
  h+=goalsBox(c)+membersBox(c)+warehouseBox(c)+chartBox(c)+ledgerBox(c)+lookupBox()+auditBox();
  $("bank-out").innerHTML=h;
  wire();
}
function bar(g){return `<div class="gbar" role="img" aria-label="${Math.round(g.pct*100)}% funded"><span class="st" style="--w:${(g.pctStock*100).toFixed(1)}%"></span><span class="ad2" style="--w:${(g.pct*100).toFixed(1)}%"></span><em>${Math.round(g.pct*100)}%</em></div>`}
function pace(missing,c){
  if(!missing) return "";
  const days=new Set(c.live.filter(e=>e.type==="income").map(e=>e.date)).size; if(days<2) return "";
  const per=c.income/days; return per>0?` At the average party income (${A(per)} per farm day) that is about <b>${Math.ceil(missing/per)}</b> more farm days.`:"";
}
function goalsBox(c){
  const done=B.data.goals.filter(g=>g.status!=="open").sort((a,b)=>b.updated-a.updated);
  return `<div class="box"><h2>Goals</h2><p class="sub">The bank adena fills the goals in priority order (1 = first). Gold = covered by adena, light = covered if the warehouse items were sold at crystal value.</p>
  ${c.goals.length?`<div class="goals">${c.goals.map((g,i)=>`<div class="goal" data-id="${esc(g.id)}">
    <div class="gh"><b>${g.priority}. ${esc(g.title)}</b>${g.member?`<span class="chip">${esc(g.member)}</span>`:""}<span class="gc">${A(g.funded)} / ${A(g.cost)}</span></div>
    ${bar(g)}${g.note?`<p class="sub">${esc(g.note)}</p>`:""}
    ${B.admin?`<div class="btns sm"><button class="ghost" data-g="up"${i?"":" disabled"}>▲</button><button class="ghost" data-g="down"${i<c.goals.length-1?"":" disabled"}>▼</button><button class="ghost" data-g="edit">Edit</button><button class="ghost" data-g="bought">Bought it</button><button class="ghost" data-g="drop">Drop</button></div>`:""}
  </div>`).join("")}</div>`:`<p class="empty">No open goals.</p>`}
  ${done.length?`<details><summary>Done and dropped (${done.length})</summary><table class="votes"><tbody>${done.map(g=>`<tr><td>${g.status==="done"?"✓":"✕"} ${esc(g.title)}</td><td>${esc(g.member||"CP")}</td><td>${A(g.cost)}</td><td>${new Date(g.updated).toLocaleDateString()}</td>${B.admin?`<td><button class="link" data-gid="${esc(g.id)}" data-g="reopen">reopen</button> · <button class="link" data-gid="${esc(g.id)}" data-g="delete">delete</button></td>`:""}</tr>`).join("")}</tbody></table></details>`:""}
  </div>`;
}
function membersBox(c){
  const rows=Object.entries(c.per).filter(([m,p])=>MEMBERS.includes(m)||p.given||p.recv);
  const max=Math.max(1,...rows.map(([,p])=>Math.max(p.given,p.recv)));
  return `<div class="box"><h2>Members</h2><p class="sub">Given = adena + items at the value written when they were given. Received = what the CP paid or handed out for him. Party income counts for nobody.</p>
  <div class="votes-table-wrap"><table class="votes mem"><thead><tr><th>Member</th><th>Given</th><th>Received</th><th>Net</th><th class="barcol"></th></tr></thead><tbody>${
    rows.sort((a,b)=>(b[1].given-b[1].recv)-(a[1].given-a[1].recv)).map(([m,p])=>{const n=p.given-p.recv;return `<tr><td><b>${esc(m)}</b>${p.last?`<br><small class="sub">last ${esc(p.last)}</small>`:""}</td><td>${A(p.given)}${p.gI?`<br><small class="sub">${short(p.gI)} in items</small>`:""}</td><td>${A(p.recv)}</td><td class="${n<0?"neg":"pos"}">${n>0?"+":""}${A(n)}</td>
      <td class="barcol"><span class="mb g" style="--w:${(p.given/max*100).toFixed(1)}%"></span><span class="mb r" style="--w:${(p.recv/max*100).toFixed(1)}%"></span></td></tr>`}).join("")
  }</tbody></table></div><p class="sub"><span class="mb g key"></span> given · <span class="mb r key"></span> received</p></div>`;
}
function warehouseBox(c){
  return `<div class="box"><h2>Warehouse</h2><p class="sub">Items the CP holds now. Value = crystal value at today's crystal price (D grade and up), or what an NPC pays for NG items.</p>
  ${c.wh.length?`<div class="votes-table-wrap"><table class="votes"><thead><tr><th>Item</th><th>Qty</th><th>Value now</th><th>Written at</th></tr></thead><tbody>${c.wh.map(s=>`<tr><td>${esc(s.item.name)}${s.it?` <small class="sub">${esc(s.it.grade)} · ${esc(s.it.sub)}</small>`:""}</td><td>${fmt(s.qty)}</td><td>${s.lo===s.hi?A(s.lo):`${A(s.lo)}–${A(s.hi)}`}</td><td>${A(s.value)}</td></tr>`).join("")}</tbody></table></div>`:`<p class="empty">Empty.</p>`}</div>`;
}
function chartBox(c){
  if(c.series.length<2) return "";
  const W=640,H=150,P=6, xs=c.series.map(s=>Date.parse(s[0])), ys=c.series.map(s=>s[1]);
  const x0=Math.min(...xs),x1=Math.max(...xs)||x0+1, y1=Math.max(1,...ys), y0=Math.min(0,...ys);
  const X=t=>P+(W-2*P)*(x1===x0?1:(t-x0)/(x1-x0)), Y=v=>H-P-(H-2*P)*(v-y0)/(y1-y0||1);
  const pts=c.series.map((s,i)=>`${X(xs[i]).toFixed(1)},${Y(ys[i]).toFixed(1)}`);
  return `<div class="box"><h2>Bank adena over time</h2><svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bank adena from ${c.series[0][0]} to ${c.series[c.series.length-1][0]}">
    <line x1="${P}" x2="${W-P}" y1="${Y(0)}" y2="${Y(0)}" class="zero"/><polyline points="${pts.join(" ")}"/>${c.series.map((s,i)=>`<circle cx="${X(xs[i]).toFixed(1)}" cy="${Y(ys[i]).toFixed(1)}" r="2.5"><title>${s[0]}: ${fmt(s[1])}</title></circle>`).join("")}</svg>
    <p class="sub">${esc(c.series[0][0])} → ${esc(c.series[c.series.length-1][0])} · peak ${A(y1)}</p></div>`;
}
function ledgerBox(c){
  const f=B.filter, all=B.data.entries.slice().sort((a,b)=>b.date.localeCompare(a.date)||b.created-a.created)
    .filter(e=>(!f.member||e.member===f.member)&&(!f.type||e.type===f.type));
  const sign=e=>({deposit:1,income:1,sale:1,purchase:-1,handout:0,expense:-1,adjust:Math.sign(e.adena)})[e.type];
  return `<div class="box"><h2>Ledger</h2>
    <div class="filters"><select id="lf-member"><option value="">All members</option>${MEMBERS.map(m=>`<option${f.member===m?" selected":""}>${esc(m)}</option>`).join("")}</select>
    <select id="lf-type"><option value="">All types</option>${Object.entries(TYPES).map(([k,t])=>`<option value="${k}"${f.type===k?" selected":""}>${t.l}</option>`).join("")}</select>
    <button class="ghost" id="csv">Export CSV</button></div>
    ${all.length?`<div class="votes-table-wrap"><table class="votes"><thead><tr><th>Date</th><th>Type</th><th>Member</th><th>Adena</th><th>Item</th><th>Note</th>${B.admin?"<th></th>":""}</tr></thead><tbody>${all.slice(0,300).map(e=>`<tr class="${e.void?"void":""}">
      <td>${esc(e.date)}</td><td>${TYPES[e.type].l}</td><td>${esc(e.member||"CP")}</td>
      <td class="${sign(e)<0?"neg":sign(e)>0?"pos":""}">${e.adena?(sign(e)<0?"−":"+")+short(Math.abs(e.adena)):""}</td>
      <td>${e.item?`${fmt(e.item.qty)}× ${esc(e.item.name)} <small class="sub">(${short(e.item.value)})</small>`:""}</td>
      <td>${esc(e.note||"")}${e.void?`<br><small class="neg">voided: ${esc(e.void.reason)}</small>`:""}</td>
      ${B.admin?`<td>${e.void?"":`<button class="link" data-void="${esc(e.id)}">void</button>`}</td>`:""}</tr>`).join("")}</tbody></table></div>
      ${all.length>300?`<p class="sub">Showing the newest 300 of ${all.length}. Export CSV for all.</p>`:""}`:`<p class="empty">No lines${f.member||f.type?" for this filter":""}.</p>`}</div>`;
}
function lookupBox(){
  return `<div class="box"><h2>Item prices</h2><p class="sub">NG and D grade items + crystals. Shop price = NPC base price + shop tax. Crystal value at today's crystal price.</p>
    <input class="text" id="lookup" type="search" placeholder="Search an item, e.g. Elven, Bow, Plate, Crystal" list="item-names" autocomplete="off">
    <div id="lookup-out"></div></div>`;
}
function lookupRender(){
  const q=($("lookup").value||"").trim().toLowerCase(); const out=$("lookup-out"); if(!out) return;
  if(q.length<2){out.innerHTML="";return}
  const hits=B.items.filter(i=>i.name.toLowerCase().includes(q)||i.sub.includes(q)).slice(0,40);
  out.innerHTML=hits.length?`<div class="votes-table-wrap"><table class="votes"><thead><tr><th>Item</th><th>Grade</th><th>Type</th><th>Shop price</th><th>Crystals</th><th>Crystal value</th></tr></thead><tbody>${hits.map(i=>{const h=hint(i);
    return `<tr><td>${esc(i.name)}</td><td>${esc(i.grade)}</td><td>${esc(i.sub)}</td><td>${A(shopPrice(i))}</td><td>${i.cat==="crystal"?"—":i.cc?fmt(i.cc):"—"}</td><td>${i.grade==="NG"&&i.cat!=="crystal"?`<small class="sub">NPC pays ${short(Math.floor(i.price/2))}</small>`:h.lo===h.hi?A(h.lo):`${A(h.lo)}–${A(h.hi)}`}</td></tr>`}).join("")}</tbody></table></div>`:`<p class="sub">No item found.</p>`;
}
function auditBox(){
  const a=B.data.audit||[]; if(!a.length) return "";
  return `<div class="box"><details><summary>Change log (${a.length})</summary><ul class="audit">${a.map(x=>`<li><small>${new Date(x.ts).toLocaleString([], {dateStyle:"short",timeStyle:"short"})}</small> ${esc(x.text)}</li>`).join("")}</ul></details></div>`;
}

/* ---------- admin: forms ---------- */
function syncEntryForm(){
  const t=$("e-type").value, d=TYPES[t];
  $("e-help").textContent=d.d+".";
  const needM=["deposit","purchase","handout"].includes(t), noM=["income","sale","expense","adjust"].includes(t);
  $("e-member-row").hidden=noM; $("e-item-row").hidden=t==="adjust"||t==="expense";
  $("e-adena-row").hidden=t==="handout";
  $("e-adena-lab").firstChild.textContent={purchase:"Cost (adena)",sale:"Sold for (adena)",expense:"Spent (adena)",adjust:"Adena (+ or −)"}[t]||"Adena";
  $("e-item-lab").firstChild.textContent={purchase:"What was bought (optional, for the record)",handout:"Item from the warehouse",sale:"Item sold"}[t]||"Item (optional)";
  if(needM&&!$("e-member").value) $("e-member").value="";
  if(t==="handout"||t==="sale"){$("item-names-wh").innerHTML=(B.c?B.c.wh:[]).map(s=>`<option value="${esc(s.item.name)}">${fmt(s.qty)} in warehouse</option>`).join("");$("e-item").setAttribute("list","item-names-wh")}
  else $("e-item").setAttribute("list","item-names");
  valueHint();
}
function findItem(name){if(!B.items||!name)return null;const n=name.trim().toLowerCase();return B.items.find(i=>i.name.toLowerCase()===n)||null}
function valueHint(){
  const name=$("e-item").value, qty=parseInt($("e-qty").value,10)||1, it=findItem(name), out=$("e-hint");
  if(!name){out.textContent="";return}
  const t=$("e-type").value;
  if((t==="handout"||t==="sale")&&B.c){const s=B.c.wh.find(x=>x.item.name.toLowerCase()===name.trim().toLowerCase());
    if(s){const per=s.value/s.qty;out.innerHTML=`In the warehouse: ${fmt(s.qty)}, written at ${A(per*qty)} for ${qty}. ${it?`Crystal value now ${A(hint(it,qty).lo)}–${A(hint(it,qty).hi)}.`:""} <button class="link" id="use-hint" data-v="${Math.round(per*qty)}">use written value</button>`;return}}
  if(!it){out.textContent="Not in the item table: type the value yourself.";return}
  const h=hint(it,qty), m=Math.round((h.lo+h.hi)/2);
  out.innerHTML=`${esc(it.grade)} · ${esc(it.sub)} · shop ${A(shopPrice(it))} · value ${h.lo===h.hi?A(h.lo):`${A(h.lo)}–${A(h.hi)}`} (${esc(h.how)}) <button class="link" id="use-hint" data-v="${m}">use ${short(m)}</button>`;
}
async function saveEntry(){
  const t=$("e-type").value, name=$("e-item").value.trim(), it=findItem(name);
  const adena=t==="handout"?0:parseAdena($("e-adena").value);
  if(Number.isNaN(adena)) return msg("e-msg","Adena: write a number like 1500000, 1.5m or 200k.",true);
  let item=null;
  if(name&&t!=="adjust"&&t!=="expense"){
    const value=parseAdena($("e-value").value), qty=parseInt($("e-qty").value,10);
    if(!Number.isInteger(qty)||qty<1) return msg("e-msg","Quantity must be 1 or more.",true);
    if(Number.isNaN(value)) return msg("e-msg","Item value: write a number like 950000 or 950k.",true);
    item={id:it?it.id:null,name:it?it.name:name,qty,value:t==="purchase"&&!value?adena:value};
  }
  const entry={type:t,date:$("e-date").value||today(),member:$("e-member-row").hidden?"":$("e-member").value,adena,item,note:$("e-note").value.trim(),goal:$("e-goal").value||null};
  $("e-save").disabled=true;
  try{
    await op({op:"entry.add",entry});
    if(entry.goal){const g=B.data.goals.find(x=>x.id===entry.goal);if(g) await op({op:"goal.save",goal:{...g,status:"done"}})}
    msg("e-msg","Saved.",false); ["e-adena","e-item","e-value","e-note"].forEach(id=>$(id).value=""); $("e-qty").value="1"; $("e-goal").value=""; $("e-hint").textContent="";
    await load();
  }catch(e){msg("e-msg",e.message,true)}finally{$("e-save").disabled=false}
}
function goalForm(g){
  $("g-id").value=g?g.id:""; $("g-title").value=g?g.title:""; $("g-member").value=g?g.member:"";
  $("g-cost").value=g?fmt(g.cost):""; $("g-note").value=g?g.note:"";
  $("g-priority").value=g?g.priority:((B.c&&B.c.goals.length?Math.max(...B.c.goals.map(x=>x.priority)):0)+1);
  $("g-item").value=g&&g.item?g.item.name:""; $("g-legend").textContent=g?"Edit goal":"New goal";
  $("g-box").open=true; $("g-title").focus();
}
async function saveGoal(){
  const cost=parseAdena($("g-cost").value), name=$("g-item").value.trim(), it=findItem(name);
  if(!cost||Number.isNaN(cost)) return msg("g-msg","Cost: write a number like 5000000 or 5m.",true);
  const old=$("g-id").value?B.data.goals.find(x=>x.id===$("g-id").value):null;
  const goal={...(old?{id:old.id}:{}),title:$("g-title").value.trim()||(it?it.name:name),member:$("g-member").value,cost,
    priority:parseInt($("g-priority").value,10)||1,status:old?old.status:"open",note:$("g-note").value.trim(),item:name?{id:it?it.id:null,name:it?it.name:name}:null};
  try{await op({op:"goal.save",goal});msg("g-msg","Goal saved.",false);goalForm(null);$("g-box").open=false;await load()}catch(e){msg("g-msg",e.message,true)}
}
async function goalAction(id,what){
  const g=B.data.goals.find(x=>x.id===id); if(!g) return;
  try{
    if(what==="edit") return goalForm(g);
    if(what==="bought"){ // prefill a purchase, the goal closes when it is saved
      $("e-box").open=true; $("e-type").value="purchase"; syncEntryForm();
      $("e-member").value=g.member||""; $("e-adena").value=fmt(g.cost); $("e-item").value=g.item?g.item.name:g.title; $("e-qty").value="1";
      $("e-note").value=`Goal: ${g.title}`; $("e-goal").value=g.id; valueHint();
      msg("e-msg","Check the real price paid and save. The goal is then marked done.",false); $("e-box").scrollIntoView({behavior:"smooth"}); return;
    }
    if(what==="up"||what==="down"){
      const list=B.c.goals, i=list.findIndex(x=>x.id===id), j=what==="up"?i-1:i+1; if(j<0||j>=list.length) return;
      const a=list[i], b=list[j]; let pa=b.priority, pb=a.priority; if(pa===pb){pa=what==="up"?pb-1:pb+1; if(pa<1){pa=1;pb=2}}
      await op({op:"goal.save",goal:strip({...a,priority:pa})}); await op({op:"goal.save",goal:strip({...b,priority:pb})});
    }
    if(what==="drop") await op({op:"goal.save",goal:strip({...g,status:"dropped"})});
    if(what==="reopen") await op({op:"goal.save",goal:strip({...g,status:"open"})});
    if(what==="delete"){ if(!confirmInline(id)) return; await op({op:"goal.delete",id}); }
    await load();
  }catch(e){msg("g-msg",e.message,true)}
}
const strip = g => ({id:g.id,title:g.title,member:g.member,cost:g.cost,priority:g.priority,status:g.status,note:g.note||"",item:g.item||null});
const armed = new Map(); // second click within 4 s confirms (no browser dialogs)
function confirmInline(id){const t=armed.get(id);if(t&&Date.now()-t<4000){armed.delete(id);return true}armed.set(id,Date.now());msg("g-msg","Click delete again to confirm.",true);return false}
async function voidLine(id,btn){
  const row=btn.closest("tr"); if(row.querySelector(".void-form")) return;
  const td=btn.parentElement; td.innerHTML=`<span class="void-form"><input class="text" placeholder="why?" maxlength="200"><button class="ghost">void</button></span>`;
  const inp=td.querySelector("input"); inp.focus();
  td.querySelector("button").addEventListener("click",async()=>{
    if(!inp.value.trim()){inp.focus();return}
    try{await op({op:"entry.void",id,reason:inp.value.trim()});await load()}catch(e){alertBox(e.message)}
  });
}
function alertBox(t){$("bank-status").textContent=t}
async function saveSettings(){
  const crystal={}; for(const g of GR){const lo=parseAdena($(`s-${g}-lo`).value),hi=parseAdena($(`s-${g}-hi`).value);
    if(Number.isNaN(lo)||Number.isNaN(hi)) return msg("s-msg",`Crystal ${g}: numbers only.`,true); crystal[g]=[lo||0,hi||lo||0]}
  try{await op({op:"settings.save",settings:{crystal,tax:parseInt($("s-tax").value,10)||0}});msg("s-msg","Saved.",false);await load()}catch(e){msg("s-msg",e.message,true)}
}
function fillSettings(){if(!B.data)return;for(const g of GR){$(`s-${g}-lo`).value=S().crystal[g][0]||"";$(`s-${g}-hi`).value=S().crystal[g][1]||""}$("s-tax").value=S().tax||0}
function csv(){
  const q=v=>`"${String(v??"").replace(/"/g,'""')}"`;
  const rows=[["date","type","member","adena","item","qty","item_value","note","voided"]].concat(
    B.data.entries.slice().sort((a,b)=>a.date.localeCompare(b.date)||a.created-b.created).map(e=>[e.date,e.type,e.member,e.adena,e.item?e.item.name:"",e.item?e.item.qty:"",e.item?e.item.value:"",e.note,e.void?e.void.reason:""]));
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([rows.map(r=>r.map(q).join(",")).join("\n")],{type:"text/csv"}));
  a.download=`cp-bank-${today()}.csv`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

/* ---------- wiring ---------- */
function wire(){
  document.querySelectorAll(".goal [data-g]").forEach(b=>b.addEventListener("click",()=>goalAction(b.closest(".goal").dataset.id,b.dataset.g)));
  document.querySelectorAll("[data-gid]").forEach(b=>b.addEventListener("click",()=>goalAction(b.dataset.gid,b.dataset.g)));
  document.querySelectorAll("[data-void]").forEach(b=>b.addEventListener("click",()=>voidLine(b.dataset.void,b)));
  $("lf-member").addEventListener("change",e=>{B.filter.member=e.target.value;render()});
  $("lf-type").addEventListener("change",e=>{B.filter.type=e.target.value;render()});
  $("csv").addEventListener("click",csv);
  const lk=$("lookup"); lk.value=B.lookupQ||""; lk.addEventListener("input",()=>{B.lookupQ=lk.value;lookupRender()}); lookupRender();
  if(B.admin){
    const opts=`<option value="">— choose —</option>`+MEMBERS.map(m=>`<option>${esc(m)}</option>`).join("");
    for(const id of ["e-member","g-member"]){const s=$(id),v=s.value;s.innerHTML=id==="g-member"?opts.replace("— choose —","CP / nobody"):opts;s.value=v}
    if(!B.settingsFilled){fillSettings();B.settingsFilled=true}
  }
}
function initForms(){
  $("e-type").innerHTML=Object.entries(TYPES).map(([k,t])=>`<option value="${k}">${t.l}</option>`).join("");
  $("e-date").value=today();
  $("e-type").addEventListener("change",syncEntryForm);
  ["e-item","e-qty"].forEach(id=>$(id).addEventListener("input",valueHint));
  $("e-hint").addEventListener("click",e=>{if(e.target.id==="use-hint")$("e-value").value=fmt(+e.target.dataset.v)});
  $("e-save").addEventListener("click",saveEntry);
  $("g-save").addEventListener("click",saveGoal);
  $("g-new").addEventListener("click",()=>goalForm(null));
  $("g-item").addEventListener("change",()=>{const it=findItem($("g-item").value);if(it){if(!$("g-title").value)$("g-title").value=it.name;if(!$("g-cost").value)$("g-cost").value=fmt(shopPrice(it));$("g-hint").innerHTML=`Shop price ${A(shopPrice(it))}`}});
  $("s-save").addEventListener("click",saveSettings);
  $("admin-btn").addEventListener("click",()=>{const k=$("admin-key").value.trim();if(!k)return;store.set("cpAdmin",k);$("admin-key").value="";load()});
  $("admin-key").addEventListener("keydown",e=>{if(e.key==="Enter")$("admin-btn").click()});
  $("admin-lock").addEventListener("click",()=>{store.set("cpAdmin","");B.admin=false;B.settingsFilled=false;msg("admin-msg","Editing switched off in this browser.",false);load()});
  syncEntryForm();
}
window.bankShow=()=>{render();load()};
document.addEventListener("DOMContentLoaded",()=>{initForms();setInterval(()=>{if(!document.hidden&&!$("view-bank").hidden&&!document.activeElement.closest("#bank-admin-tools"))load()},30000)});
})();
