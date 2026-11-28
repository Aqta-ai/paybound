const REASONS=["Ok","Paused","NotAgent","BadSignature","NotEnoughApprovers","Expired","Revoked","UsesExhausted","TokenMismatch","RecipientMismatch","RecipientNotAllowed","ZeroAmount","AmountAboveApproval","CapExceeded","DailyLimitExceeded","InsufficientBalance"];
const SUPPLIER="0xc2177666cf501222986a3c447f03327f9d366cc6";
const short=(a)=>a.slice(0,6)+"…"+a.slice(-4);
const amt=(w)=>{const n=Number(BigInt(w)/10n**16n)/100;return n.toLocaleString("en-GB",{maximumFractionDigits:2})};
const canon=(v)=>Array.isArray(v)?"["+v.map(canon).join(",")+"]":v&&typeof v==="object"?"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canon(v[k])).join(",")+"}":JSON.stringify(v);
async function sha256(s){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}
// Build DOM nodes; every string child is inserted as text, never parsed as HTML.
function h(tag,attrs,...kids){const el=document.createElement(tag);for(const [k,v] of Object.entries(attrs||{})){if(v==null||v===false)continue;if(k==="class")el.className=v;else el.setAttribute(k,v)}
 for(const c of kids.flat()){if(c==null||c===false)continue;el.append(c instanceof Node?c:document.createTextNode(String(c)))}return el}
const isHex=(s,n)=>typeof s==="string"&&new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(s);
const scan=(href)=>h("a",{class:"m",href,target:"_blank",rel:"noopener"});

const [ev,recs]=await Promise.all([fetch("/api/events").then(r=>r.json()).catch(()=>({error:"Could not read BNB testnet right now. Try again in a minute."})),fetch("/records.json").then(r=>r.json()).catch(()=>[])]);
const byTx=new Map(recs.map(r=>[r.tx,r]));
const list=document.getElementById("list");
if(ev.error){list.replaceChildren(h("div",{class:"skel"},String(ev.error)));}
else{
 const events=ev.events.filter(e=>isHex(e.tx,64)&&isHex(e.recipient,40));
 const paid=events.filter(e=>e.kind==="paid"),ref=events.filter(e=>e.kind==="refused");
 document.getElementById("sPaid").textContent=paid.length;document.getElementById("sRef").textContent=ref.length;
 document.getElementById("sWrong").textContent=paid.filter(e=>e.recipient.toLowerCase()!==SUPPLIER).length;
 const live=Number.isInteger(ev.liveFrom)?` · indexed to block ${ev.indexedTo.toLocaleString()}, blocks ${ev.liveFrom.toLocaleString()}–${ev.head.toLocaleString()} read live`+(ev.gap?`, blocks ${ev.gap.from.toLocaleString()}–${ev.gap.to.toLocaleString()} not yet indexed`:""):"";
 document.getElementById("meta").textContent=`${events.length} decisions · blocks ${Number(ev.start).toLocaleString()}–${Number(ev.head).toLocaleString()}${live}`;
 list.replaceChildren(...events.map((e,i)=>{const tx=e.tx.toLowerCase();const rec=byTx.get(tx);const isPaid=e.kind==="paid";const url="https://testnet.bscscan.com/tx/"+tx;
  const link=scan(url);link.textContent=short(tx)+" ↗";
  return h("div",{class:"row",id:"tx-"+tx,"data-kind":isPaid?"paid":"refused","data-i":String(i)},
   h("span",null,h("span",{class:"badge "+(isPaid?"paid":"refused")},isPaid?"Paid":"Refused")),
   h("span",null,isPaid?"Approved supplier":(REASONS[e.reason]||"Refused")," ",h("span",{class:"m"},"to "+short(e.recipient))),
   h("span",{class:"num hide"},amt(e.amount)," ",h("span",{class:"muted"},"test USD")),
   h("span",{class:"hide"},link),
   h("span",null,rec?h("button",{class:"btn seal","data-tx":tx,type:"button"},"Seal record"):h("a",{class:"btn",href:url,target:"_blank",rel:"noopener"},"BscScan")));
 }));
}
const tick=(ok)=>h("span",{class:ok?"ok":"bad"},ok?"✓":"✕");
document.addEventListener("click",async(evt)=>{const b=evt.target.closest(".btn.seal");if(!b)return;const row=b.closest(".row");const open=row.querySelector(".check");if(open){open.remove();return}
 const r=byTx.get(b.dataset.tx);if(!r)return;const el=h("div",{class:"check"},"Checking…");row.appendChild(el);
 const hsh=await sha256(canon(r.args));const hashOk=hsh===r.record.args_hash;const txOk=String(r.args.tx_hash).toLowerCase()===b.dataset.tx;
 let log;try{const p=await fetch("/api/proof?id="+encodeURIComponent(r.record.action_id)).then(x=>x.json());log=Number.isInteger(p.leaf_index)&&Number.isInteger(p.tree_size)?[tick(true)," In Seal's public log: leaf "+p.leaf_index.toLocaleString()+" of "+p.tree_size.toLocaleString()+" (as reported through this site's proxy)"]:[tick(false)," Not found in the log"]}catch{log=["Log unavailable right now"]}
 const vOut=String(r.args.vault_outcome||""),vReason=String(r.args.vault_reason||"");
 el.replaceChildren(
  h("p",{class:"verdictLine"},h("b",null,"Vault verdict: "),h("span",{class:vOut==="Executed"?"ok":"bad"},vOut==="Executed"?"Paid":(vOut||"unknown")),vOut==="Executed"?" (signed as Executed)":vReason?", "+vReason:""," · ",h("b",null,"Seal outcome: "),String(r.record.outcome)," (record accepted)"),
  h("ul",null,
   h("li",null,tick(txOk)," The record names this exact transaction"),
   h("li",null,tick(hashOk)," SHA-256 of the record's arguments matches its signed hash (computed in your browser)"),
   h("li",null,...log),
   h("li",{class:"muted"},"Check the Ed25519 signature offline: ",h("span",{class:"m"},"npx aqta-verify-receipt record.json --profile action-1 --key 9Y3Eiq6V8QjRDUM5nPqSwKIOPQaoEU4SbagfYFdvWa4")," · record id ",h("span",{class:"m"},String(r.record.action_id)))),
  h("p",{class:"note"},"Seal signed a record of the vault's decision after it landed on chain. outcome ALLOWED means Seal accepted the record; the vault's verdict (Paid, signed as Executed, or Refused, with its reason) is inside the signed arguments."));
});

document.addEventListener("click",(evt)=>{const a=evt.target.closest(".side a.k");if(!a)return;evt.preventDefault();const row=document.getElementById(a.getAttribute("href").slice(1));if(!row)return;
 row.scrollIntoView({behavior:"smooth",block:"center"});row.classList.add("hl");setTimeout(()=>row.classList.remove("hl"),1600);const s=row.querySelector(".btn.seal");if(s&&!row.querySelector(".check"))s.click();});

const reduce=matchMedia("(prefers-reduced-motion: reduce)").matches;
if(!ev.error){
 const c=document.getElementById("c3d");
 const draw2d=()=>{document.getElementById("viz").classList.add("flat")};
 if(reduce||innerWidth<700||!window.WebGLRenderingContext){draw2d();}
 else (window.requestIdleCallback||((f)=>setTimeout(f,300)))(()=>import("./hero3d.js").then(m=>m.startHero(c,ev.events)).catch(draw2d));
}
let filt="all",qv="";
function applyFilter(){document.querySelectorAll("#list .row").forEach(r=>{const ok=(filt==="all"||r.dataset.kind===filt)&&(!qv||r.id.includes(qv));r.classList.toggle("hidden",!ok)})}
document.addEventListener("click",e=>{const b=e.target.closest(".chip2");if(!b)return;document.querySelectorAll(".chip2").forEach(x=>x.classList.toggle("on",x===b));filt=b.dataset.f;applyFilter();});
document.getElementById("q").addEventListener("input",e=>{qv=e.target.value.trim().toLowerCase();applyFilter();});

const SUP="0xc2177666CF501222986A3c447f03327F9D366cc6";
const rnd=()=>"0x"+[...crypto.getRandomValues(new Uint8Array(20))].map(b=>b.toString(16).padStart(2,"0")).join("");
const tw=document.getElementById("tw"),ta=document.getElementById("ta"),tf=document.getElementById("tf"),tv=document.getElementById("tv");
tw.value=rnd();
const EXPLAIN={RecipientMismatch:"That wallet is not the one the person approved. Nothing would move.",AmountAboveApproval:"More than the approved ceiling of 3,400. Nothing would move.",BadSignature:"The approval was not signed by an approver. Nothing would move.",ZeroAmount:"Zero is not a payment.",Expired:"The approval has expired. Nothing would move.",UsesExhausted:"The approval has already been used. Nothing would move.",Paused:"The vault is paused. Nothing would move.",Ok:"Exactly what the person approved: the vault would pay this once. (Read-only check, so nothing was sent.)"};
const big=(t)=>h("div",{class:"big"},t),ex=(t)=>h("div",{class:"ex"},t);
async function ask(){tv.className="verdict";tv.replaceChildren(big("Asking the vault…"));
 try{const r=await fetch(`/api/check?recipient=${encodeURIComponent(tw.value.trim())}&amount=${encodeURIComponent(ta.value.trim())}&forge=${tf.checked?1:0}`).then(x=>x.json());
  if(r.error){tv.replaceChildren(big("Check the input"),ex(String(r.error)));return}
  const reason=String(r.reason);
  tv.className="verdict "+(r.wouldPay?"yes":"no");
  const w=tw.value.trim(),a=ta.value.trim(),wBad=w.toLowerCase()!==SUP.toLowerCase(),aBad=Number(a)>3400,sBad=tf.checked;
  tv.replaceChildren(big(r.wouldPay?"Would pay":"Refused"),h("div",{class:"why"},reason),ex(EXPLAIN[reason]||"The vault refused this request. It reports the first check that failed."),
   h("div",{class:"cmp"},
    h("div",null,h("b",null,"The AI asked"),h("span",{class:"m"+(wBad?" bad":"")},w.slice(0,8)+"…"+w.slice(-4)),h("br"),h("span",{class:"m"+(aBad?" bad":"")},Number(a).toLocaleString("en-GB")+" test USD"),h("br"),h("span",{class:"m"+(sBad?" bad":"")},sBad?"forged signature":"approver's signature")),
    h("div",null,h("b",null,"The person approved"),h("span",{class:"m"},"Kowloon Ceramics 0xc217…6cc6"),h("br"),h("span",{class:"m"},"up to 3,400 test USD, once"),h("br"),h("span",{class:"m"},"signed by the approver"))),
   ex("Answered by the vault contract's own check on BNB Smart Chain testnet."));
 }catch{tv.replaceChildren(big("Try again"),ex("The vault could not be reached."))}}
document.getElementById("tgo").addEventListener("click",ask);
document.querySelector(".presets").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;const p=b.dataset.p;
 if(p==="wallet"){tw.value=rnd();ta.value="3400";tf.checked=false}
 if(p==="amount"){tw.value=SUP;ta.value="3900";tf.checked=false}
 if(p==="forge"){tw.value=SUP;ta.value="3400";tf.checked=true}
 if(p==="real"){tw.value=SUP;ta.value="3400";tf.checked=false}
 ask();});

document.getElementById("vbtn").addEventListener("click",()=>{const row=document.getElementById("tx-0xc7aca06e38fa998ef560676453cb1d37531135ff0b72a93c71fdd6c33e79dd7e")||document.querySelector(".btn.seal")?.closest(".row");if(!row)return;row.scrollIntoView({behavior:"smooth",block:"center"});row.classList.add("hl");setTimeout(()=>row.classList.remove("hl"),1600);const s=row.querySelector(".btn.seal");if(s&&!row.querySelector(".check"))s.click();});
