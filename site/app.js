const REASONS=["Ok","Paused","NotAgent","BadSignature","NotEnoughApprovers","Expired","Revoked","UsesExhausted","TokenMismatch","RecipientMismatch","RecipientNotAllowed","ZeroAmount","AmountAboveApproval","CapExceeded","DailyLimitExceeded","InsufficientBalance"];
const SUPPLIER="0xc2177666cf501222986a3c447f03327f9d366cc6";
const short=(a)=>a.slice(0,6)+"…"+a.slice(-4);
const amt=(w)=>{const n=Number(BigInt(w)/10n**16n)/100;return n.toLocaleString("en-GB",{maximumFractionDigits:2})};
const canon=(v)=>Array.isArray(v)?"["+v.map(canon).join(",")+"]":v&&typeof v==="object"?"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canon(v[k])).join(",")+"}":JSON.stringify(v);
async function sha256(s){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}
const [ev,recs]=await Promise.all([fetch("/api/events").then(r=>r.json()),fetch("/records.json").then(r=>r.json())]);
const byTx=new Map(recs.map(r=>[r.tx,r]));
if(ev.error){document.getElementById("list").innerHTML=`<div class="skel">${ev.error}</div>`;}
else{
 const paid=ev.events.filter(e=>e.kind==="paid"),ref=ev.events.filter(e=>e.kind==="refused");
 document.getElementById("sPaid").textContent=paid.length;document.getElementById("sRef").textContent=ref.length;
 document.getElementById("sWrong").textContent=paid.filter(e=>e.recipient.toLowerCase()!==SUPPLIER).length;
 document.getElementById("meta").textContent=`${ev.events.length} decisions · blocks ${ev.start.toLocaleString()}–${ev.head.toLocaleString()}`;
 document.getElementById("list").innerHTML=ev.events.map((e,i)=>{const rec=byTx.get(e.tx.toLowerCase());return `<div class="row" id="tx-${e.tx.toLowerCase()}" data-i="${i}">
 <span><span class="badge ${e.kind}">${e.kind==="paid"?"Paid":"Refused"}</span></span>
 <span>${e.kind==="paid"?"Approved supplier":REASONS[e.reason]||"Refused"} <span class="m">to ${short(e.recipient)}</span></span>
 <span class="num hide">${amt(e.amount)} <span class="muted">test USD</span></span>
 <span class="hide"><a class="m" href="https://testnet.bscscan.com/tx/${e.tx}" target="_blank" rel="noopener">${short(e.tx)} ↗</a></span>
 <span>${rec?`<button class="btn seal" data-tx="${e.tx.toLowerCase()}">Seal record</button>`:`<a class="btn" href="https://testnet.bscscan.com/tx/${e.tx}" target="_blank" rel="noopener">BscScan</a>`}</span></div>`}).join("");
}
document.addEventListener("click",async(ev)=>{const b=ev.target.closest(".btn.seal");if(!b)return;const row=b.closest(".row");const open=row.querySelector(".check");if(open){open.remove();return}
 const r=byTx.get(b.dataset.tx);const el=document.createElement("div");el.className="check";el.innerHTML="Checking…";row.appendChild(el);
 const h=await sha256(canon(r.args));const hashOk=h===r.record.args_hash;const txOk=r.args.tx_hash.toLowerCase()===b.dataset.tx;
 let log="";try{const p=await fetch("/api/proof?id="+r.record.action_id).then(x=>x.json());log=Number.isInteger(p.leaf_index)?`<span class="ok">✓</span> In Seal's public log: leaf ${p.leaf_index.toLocaleString()} of ${p.tree_size.toLocaleString()}`:`<span class="bad">✕</span> Not found in the log`}catch{log="Log unavailable right now"}
 el.innerHTML=`<ul style="margin:0;padding:0"><li><span class="${txOk?"ok":"bad"}">${txOk?"✓":"✕"}</span> The record names this exact transaction</li><li><span class="${hashOk?"ok":"bad"}">${hashOk?"✓":"✕"}</span> SHA-256 of the record's arguments matches its signed hash (computed in your browser)</li><li>${log}</li><li class="muted">Check the Ed25519 signature offline: <span class="m">npx aqta-verify-receipt record.json --profile action-1 --key 9Y3Eiq6V8QjRDUM5nPqSwKIOPQaoEU4SbagfYFdvWa4</span> · record id <span class="m">${r.record.action_id}</span></li></ul>`;
});

document.addEventListener("click",(ev)=>{const a=ev.target.closest(".side a.k");if(!a)return;ev.preventDefault();const row=document.getElementById(a.getAttribute("href").slice(1));if(!row)return;
 row.scrollIntoView({behavior:"smooth",block:"center"});row.classList.add("hl");setTimeout(()=>row.classList.remove("hl"),1600);const s=row.querySelector(".btn.seal");if(s&&!row.querySelector(".check"))s.click();});
