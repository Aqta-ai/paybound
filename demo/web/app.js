// SPDX-License-Identifier: Apache-2.0
// Demo page logic. Plain browser JavaScript, no build step.
(() => {
  const $ = (id) => document.getElementById(id);
  let lang = "en";
  // Stage mode (?stage=1): big steps and status, clutter hidden, light theme. Remembered for this tab.
  let stage = new URLSearchParams(location.search).get("stage") === "1";
  function workingText() { return typeof info !== "undefined" && info && info.network === "bsc-testnet" ? t().working : t().workingLocal; }
  // Theme: dark by default on stage (LED walls), light otherwise; ?theme= or the toggle overrides.
  const applyTheme = (t) => { document.body.classList.toggle("dark", t === "dark"); const b = document.getElementById("theme"); if (b) b.innerHTML = t === "dark" ? "&#9728;" : "&#9790;"; };
  let theme = new URLSearchParams(location.search).get("theme");
  try { theme = theme || localStorage.getItem("sg-theme"); } catch {}
  theme = theme || (stage ? "dark" : "light");
  document.addEventListener("DOMContentLoaded", () => {
    applyTheme(theme);
    document.getElementById("theme")?.addEventListener("click", () => { theme = theme === "dark" ? "light" : "dark"; applyTheme(theme); try { localStorage.setItem("sg-theme", theme); } catch {} });
  });
  if (document.readyState !== "loading") applyTheme(theme);
  try {
    if (stage) sessionStorage.setItem("stage-mode", "1");
    else stage = sessionStorage.getItem("stage-mode") === "1";
  } catch {}
  const forcedLang = new URLSearchParams(location.search).get("lang");
  let info = null;
  let prefilled = false;
  const eventRows = [];
  // The stream replays every row of this run when it reconnects, so each row is kept once, by the
  // id the server gives it (transaction hash and log index).
  const eventIds = new Set();
  const rowId = (r) => r.id || `${r.txHash}:${r.logIndex ?? r.event}`;
  const clearEvents = () => {
    eventRows.length = 0;
    eventIds.clear();
  };
  /** True once the vault's own event from this transaction has reached the activity list. */
  const seen = (hash) => eventRows.some((r) => String(r.txHash).toLowerCase() === String(hash).toLowerCase());
  try {
    const saved = localStorage.getItem("demo-lang");
    if (saved === "th" || saved === "en" || saved === "zh") lang = saved;
    if (forcedLang === "th" || forcedLang === "en" || forcedLang === "zh") lang = forcedLang;
  } catch {}

  const t = () => window.I18N[lang];
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
  const fmt = (n) => Number(n).toLocaleString(lang === "th" ? "th-TH" : lang === "zh" ? "zh-CN" : "en-GB", { maximumFractionDigits: 2 });
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // The stage token comes from the address the server printed (?token=...) and is kept for this tab.
  let stageToken = new URLSearchParams(location.search).get("token") || "";
  try {
    if (stageToken) sessionStorage.setItem("stage-token", stageToken);
    else stageToken = sessionStorage.getItem("stage-token") || "";
  } catch {}
  if (stageToken && location.search) history.replaceState(null, "", location.pathname);

  async function api(path, body) {
    const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json", "x-stage-token": stageToken }, body: JSON.stringify(body) } : {});
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }

  function scenario() {
    return info.scenarios.find((s) => s.id === info.scenarioId);
  }

  function who(addr) {
    if (!addr) return "";
    const a = addr.toLowerCase();
    if (a === info.payee.toLowerCase()) return scenario().payee[lang];
    if (a === info.attacker.toLowerCase()) return lang === "th" ? "กระเป๋าเงินคนร้าย" : lang === "zh" ? "攻击者的钱包" : "attacker's wallet";
    if (info.agentLog.some((x) => x.emailId === "judge" && x.decision && x.decision.recipient.toLowerCase() === a)) return lang === "th" ? "กระเป๋าเงินของคุณ" : lang === "zh" ? "你的钱包" : "your wallet";
    return short(addr);
  }

  function txLink(hash) {
    if (!info.explorer) return el("span", "hash", short(hash));
    const a = el("a", "hash", short(hash));
    a.href = `${info.explorer}/tx/${hash}`;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }

  // ------------------------------------------------------------------ render

  function renderStatic() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((n) => {
      const v = t()[n.dataset.i18n];
      if (typeof v === "string") n.textContent = v;
    });
    document.querySelectorAll(".lang button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
    $("review-note").hidden = lang === "en";
  }

  function currentStep() {
    if (!info.approval) return 1;
    const paid = info.agentLog.some((x) => x.outcome === "Executed");
    if (paid) return 4;
    // Step 3 starts when the vault's refusal of the judge's attack is on screen, not when the agent
    // answers: the chain event can arrive a block or two later. An attempt that sent nothing to the
    // vault (the agent declined, or a market check held it) leaves the stage on step 2 to try again.
    const judged = info.agentLog.some((x) => x.emailId === "judge" && x.txHash && seen(x.txHash));
    return judged ? 3 : 2;
  }

  function renderStage() {
    document.body.classList.toggle("stage", stage);
    document.body.classList.toggle("has-approval", Boolean(info && info.approval));
    $("steps").hidden = !stage;
    if (!stage || !info) return;
    const step = currentStep();
    document.querySelectorAll("#steps li").forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle("done", n < step);
      li.classList.toggle("now", n === step);
      li.querySelector("span").textContent = n < step ? "✓" : String(n);
    });
    const waiting = step === 1 && info.phoneWaiting;
    // The judge's attack is on chain but the vault's refusal has not reached the list yet: keep
    // saying "working" rather than showing the step 2 prompt again.
    const landing = step === 2 && info.agentLog.some((x) => x.emailId === "judge" && x.txHash && !seen(x.txHash));
    $("status").textContent = (running || landing ? workingText() : t()[waiting ? "s1wait" : `s${step}`]).replace(/^(Step \d\. |ขั้นที่ \d |第 \d 步：)/, "");
    // In stage mode the result button waits until the real payment has gone through.
    if (!running) $("show-result").disabled = step < 4;
  }

  function showError(message) {
    $("error").textContent = message;
    $("error").hidden = false;
    clearTimeout(showError.timer);
    showError.timer = setTimeout(() => ($("error").hidden = true), 8000);
  }

  function render() {
    renderStatic();
    if (!info) return;
    if (stage) prefilled = true;
    const s = scenario();
    $("network").textContent = t().net[info.network];
    $("network").className = `badge ${info.network}`;
    $("model").textContent = `${t().agentModel}: ${info.model}`;
    const sel = $("scenario");
    sel.replaceChildren(...info.scenarios.map((x) => {
      const o = el("option", null, x.title[lang]);
      o.value = x.id;
      o.selected = x.id === info.scenarioId;
      return o;
    }));
    $("blurb").textContent = s.blurb[lang];
    $("request").textContent = info.request;
    if (prefilled) {
      $("f-payee").value = `${s.payee[lang]} (${short(info.payee)})`;
      $("f-amount").value = `${fmt(s.approval.amount)} test USD`;
      $("f-uses").value = String(s.approval.uses);
      $("f-hours").value = `${s.approval.hours} ${t().hours}`;
    } else {
      ["f-payee", "f-amount", "f-uses", "f-hours"].forEach((id) => ($(id).value = ""));
    }
    $("approve").disabled = !prefilled || !!info.approval;
    $("approve-phone").disabled = !prefilled || !!info.approval;
    $("approved").hidden = !info.approval;
    if (info.approval) {
      const by =
        info.approval.by === "passkey"
          ? `${t().byPasskey} ${short(info.approval.signer)}`
          : info.approval.by === "phone"
            ? `${t().byPhone} ${short(info.approval.signer)}`
            : t().byDemo;
      const f = info.fiat;
      const fiatText = f ? ` · ${t().fiatNote(fmt(Math.round(f.value)), f.fiat, f.lastUpdated.slice(11, 16))}` : "";
      $("approved").textContent = `${by} · ${short(info.approval.digest)} · ${s.approval.label[lang]}${fiatText}`;
    }
    $("phone-wait").hidden = !info.phoneWaiting || !!info.approval;
    if (info.phoneWaiting) {
      $("phone-wait").textContent = info.phoneUrl ? t().phoneWait(info.phoneUrl) : t().phoneWaitNoUrl;
      fetch("/api/phone/draft").then((r) => r.json()).then((d) => {
        if (d.draft) $("phone-wait").textContent += ` · ${d.draft.digest.slice(2, 6)} ${d.draft.digest.slice(6, 10)} … ${d.draft.digest.slice(-4)}`.toUpperCase();
      }).catch(() => {});
    }

    const inbox = $("inbox");
    inbox.replaceChildren(...s.emails.map((e) => {
      const li = el("li", `mail ${e.kind}`);
      const head = el("div", "mail-head");
      head.append(el("span", `tag ${e.kind}`, t().kinds[e.kind]), el("span", "from", e.from));
      li.append(head, el("div", "subject", e.subject[lang]), el("p", "body", e.body[lang]));
      const b = el("button", "run", t().run);
      b.type = "button";
      b.dataset.email = e.id;
      b.disabled = !info.approval;
      li.append(b);
      return li;
    }));
    $("stolen").disabled = false;
    const mk = info.market || {};
    $("market").hidden = !mk.enabled;
    $("sim-fx").hidden = Boolean(info.fxShift);
    $("sim-fx-clear").hidden = !info.fxShift;
    $("market-mode").textContent = t().marketMode(mk.pegSymbol, mk.atlas ? "CoinMarketCap + Atlas" : "CoinMarketCap");
    if (mk.simulated != null) $("sim-on").textContent = t().simOn(mk.simulated);
    $("sim-depeg").hidden = mk.simulated != null;
    $("sim-clear").hidden = mk.simulated == null;
    $("sim-on").hidden = mk.simulated == null;
    renderReasoning();
    renderEvents();
    renderStage();
    // A language switch mid-step must not re-enable controls that are locked for the running step.
    if (running) document.querySelectorAll("button").forEach((b) => { if (!b.dataset.lang && b.id !== "result-close") b.disabled = true; });
  }

  function renderReasoning() {
    const s = scenario();
    const ol = $("reasoning");
    ol.replaceChildren(...info.agentLog.slice().reverse().map((x) => {
      const li = el("li", `step ${x.outcome === "Refused" ? "bad" : x.outcome === "Executed" ? "good" : x.outcome === "Held" ? "held" : ""}`);
      const mail = s.emails.find((e) => e.id === x.emailId);
      const title = mail ? mail.subject[lang] : x.emailId === "judge" ? t().judgeTitle : t().stolen;
      const d = x.decision || {};
      const off = d.recipient && d.recipient.toLowerCase() !== info.payee.toLowerCase();
      li.append(el("div", "s-title", `${t().read}: ${title}${x.attempt ? ` · ${t().attempt} ${x.attempt}` : ""}`));
      li.append(
        el(
          "div",
          "s-body",
          d.pay
            ? `${t().decided} ${fmt(d.amount)} test USD ${t().to} ${off ? t().newWallet : t().onFile} (${short(d.recipient)})`
            : t().declined,
        ),
      );
      if (d.note) {
        const th = el("div", "s-thought");
        th.append(el("b", "", t().thought), el("q", "", d.note));
        li.append(th);
      }
      if (x.market) {
        const m = x.market;
        for (const q of m.quotes) {
          const source = q.simulated ? t().priceSim : q.source;
          const asOf = String(q.lastUpdated).replace("T", " ").slice(0, 19);
          const age = Math.floor((Date.parse(m.checkedAt) - Date.parse(q.lastUpdated)) / 1000);
          const line = t().priceSeen(source, m.symbol, Number(q.price).toFixed(6), asOf, age);
          const item = el("div", "s-market", line);
          if (q.source === "Atlas") {
            const link = el("a", "hash", t().atlasRound(q.block, q.round));
            link.href = `https://bscscan.com/block/${q.block}`;
            link.target = "_blank";
            link.rel = "noopener";
            item.append(" · ", link);
          }
          li.append(item);
        }
        if (m.reasons.length) li.append(el("div", "s-market", m.reasons.map(reason => t().marketReason(reason, m)).join(". ")));
      }
      if (x.fx) {
        const f = x.fx;
        li.append(el("div", "s-market", t().fxLine(f.fiat, fmt(Math.round(f.approved)), fmt(Math.round(f.now)), (f.change * 100).toFixed(1)) + (f.simulated ? ` (${t().priceSim})` : "")));
      }
      const res = el("div", "s-res");
      res.append(el("strong", null, t().outcomes[x.outcome] || x.outcome));
      if (x.reason && x.reason !== "Ok") res.append(` · ${t().reasons[x.reason] || x.reason}`);
      if (x.txHash) res.append(" · ", txLink(x.txHash));
      li.append(res);
      return li;
    }));
  }

  function renderEvents() {
    const ol = $("events");
    ol.replaceChildren(...eventRows.slice().reverse().map((r) => {
      const bad = r.event === "SpendRefused";
      const li = el("li", `ev ${bad ? "refused" : r.event === "SpendExecuted" ? "paid" : r.event === "Frozen" ? "frozen" : ""}`);
      const top = el("div", "ev-top");
      top.append(el("span", "ev-name", t().events[r.event] || r.event));
      if (r.reason) top.append(el("span", "ev-why", t().reasons[r.reason] || r.reason), el("span", "ev-code", r.reason));
      top.append(el("span", "ev-block", `block ${r.block}`));
      li.append(top);
      const parts = [];
      if (r.amount) parts.push(`${fmt(r.amount)} test USD ${t().to} ${who(r.recipient)}`);
      const sub = el("div", "ev-sub", parts.join(" · "));
      sub.append(" ", txLink(r.txHash));
      li.append(sub);
      return li;
    }));
    $("vault-addr").textContent = `${t().vaultAt} ${info.vault} · chain ${info.chainId}`;
    const payee = (info.payee || "").toLowerCase();
    const redirect = (r) => r.recipient && r.recipient.toLowerCase() !== payee;
    const tries = eventRows.filter((r) => (r.event === "SpendRefused" || r.event === "SpendExecuted") && redirect(r));
    $("t-tries").textContent = tries.length;
    $("t-refused").textContent = tries.filter((r) => r.event === "SpendRefused").length;
    $("t-taken").textContent = fmt(tries.filter((r) => r.event === "SpendExecuted").reduce((a, r) => a + Number(r.amount || 0), 0));
    const last = eventRows[eventRows.length - 1];
    const g = $("guard");
    g.classList.remove("ok", "no");
    if (!last) $("guard-say").textContent = t().guardIdle;
    else if (last.event === "SpendRefused") { g.classList.add("no"); $("guard-say").textContent = t().guardNo(t().reasons[last.reason] || last.reason); }
    else if (last.event === "SpendExecuted") { g.classList.add("ok"); $("guard-say").textContent = t().guardOk; }
  }

  async function refreshBalances() {
    if (!info) return;
    try {
      const b = await api("/api/balances");
      $("b-payee").textContent = `${fmt(b.payee)} test USD`;
      $("b-attacker").textContent = `${fmt(b.attacker)} test USD`;
      $("b-vault").textContent = `${fmt(b.vault)} test USD`;
      const st = $("vault-state");
      st.textContent = b.paused ? t().frozen : t().active;
      st.className = `state ${b.paused ? "frozen" : "active"}`;
      document.body.classList.toggle("is-frozen", b.paused);
      $("freeze").disabled = b.paused;
      $("unfreeze").disabled = !b.paused;
    } catch {}
  }



  // ------------------------------------------------------------------ events

  let liveEvents = false;
  function connect() {
    setTimeout(() => (liveEvents = true), 1500);
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      const row = JSON.parse(m.data);
      const id = rowId(row);
      if (eventIds.has(id)) return;
      eventIds.add(id);
      eventRows.push(row);
      renderEvents();
      // A refusal arriving here is what moves the stage from step 2 to step 3.
      renderStage();
      refreshBalances();
      if (liveEvents && window.vaultScene) {
        if (row.event === "SpendRefused") window.vaultScene.refuse();
        else if (row.event === "SpendExecuted" || row.event === "SpendReleased") window.vaultScene.pay();
      }
    };
    es.addEventListener("reset", () => {
      clearEvents();
      renderEvents();
    });
  }

  // One step at a time: every button is locked while a step runs, so a double click cannot send twice.
  let running = false;
  async function act(fn) {
    if (running) return;
    running = true;
    document.body.classList.add("busy");
    $("error").hidden = true;
    if (stage) $("status").textContent = workingText();
    const buttons = [...document.querySelectorAll("button")].filter((b) => !b.disabled && !b.dataset.lang && b.id !== "result-close");
    buttons.forEach((b) => (b.disabled = true));
    try {
      await fn();
    } catch (e) {
      showError(e.message);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
      running = false;
      document.body.classList.remove("busy");
      if (info) render();
      // Balances can lag the chain by a block or two: read them now and again shortly after.
      refreshBalances();
      setTimeout(refreshBalances, 3500);
    }
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.dataset.lang) {
      lang = b.dataset.lang;
      try {
        localStorage.setItem("demo-lang", lang);
      } catch {}
      render();
      refreshBalances();
    } else if (b.id === "prefill") {
      prefilled = true;
      render();
    } else if (b.dataset.email) {
      act(async () => {
        await api("/api/agent", { emailId: b.dataset.email, lang });
        info = await api("/api/info");
        renderReasoning();
      });
    } else if (b.id === "stolen") {
      act(async () => {
        await api("/api/stolen-key", {});
        info = await api("/api/info");
        renderReasoning();
      });
    } else if (b.id === "approve-phone") {
      act(async () => {
        await api("/api/phone/draft", {});
        info = await api("/api/info");
        render();
        const poll = setInterval(async () => {
          try {
            info = await api("/api/info");
            if (info.approval || !info.phoneWaiting) {
              clearInterval(poll);
              render();
            }
          } catch {}
        }, 1500);
      });
    } else if (b.id === "sim-fx" || b.id === "sim-fx-clear") {
      act(async () => {
        info = await api("/api/market/simulate", { fxShift: b.id === "sim-fx" ? 0.03 : 0 });
        render();
      });
    } else if (b.id === "sim-depeg" || b.id === "sim-clear") {
      act(async () => {
        info = await api("/api/market/simulate", { price: b.id === "sim-depeg" ? 0.97 : null });
        render();
      });
    } else if (b.id === "show-result") {
      act(showResult);
    } else if (b.id === "result-close") {
      $("result").hidden = true;
    } else if (b.id === "freeze") {
      act(async () => {
        await api("/api/freeze", {});
        refreshBalances();
      });
    } else if (b.id === "unfreeze") {
      act(async () => {
        await api("/api/unfreeze", {});
        refreshBalances();
      });
    }
  });

  $("approve-form").addEventListener("submit", (e) => {
    e.preventDefault();
    act(async () => {
      info = await api("/api/approve", {});
      render();
    });
  });

  async function showResult() {
    const r = await api("/api/summary");
    const paid = r.paid.filter((x) => x.recipient && x.recipient.toLowerCase() === r.payee.toLowerCase());
    $("result-h").textContent = paid.length === 0 ? t().paidNone : paid.length === 1 ? t().paidOnce : t().paidN(paid.length);
    const total = paid.reduce((s, x) => s + Number(x.amount), 0);
    $("result-sub").textContent = t().resSub(fmt(total), r.refused.length);
    // One row per vault decision, in chain order: a status chip, what was asked, why, and a link.
    const rows = [...r.paid.map((x) => ({ ...x, ok: true })), ...r.refused.map((x) => ({ ...x, ok: false }))].sort((a, b) => Number(a.block) - Number(b.block));
    $("result-rows").replaceChildren(...rows.map((x) => {
      const li = el("li", `rrow ${x.ok ? "ok" : "no"}`);
      li.append(el("span", "rchip", x.ok ? t().outcomes.Executed : t().outcomes.Refused));
      if (info.agentLog.some((e) => e.emailId === "judge" && e.txHash === x.txHash)) li.classList.add("mine");
      const main = el("div", "rmain");
      main.append(el("div", "rwhat", `${fmt(x.amount)} test USD ${t().to} ${who(x.recipient)} (${x.recipient.slice(0, 6)}…${x.recipient.slice(-4)})`));
      if (!x.ok && x.reason) main.append(el("div", "rwhy", t().reasons[x.reason] || x.reason));
      li.append(main, txLink(x.txHash));
      return li;
    }));
    $("result-foot").textContent = t().resFoot(t().net[info.network] || info.network);
    // The judge's own attack if there is one, otherwise the vault's full event list.
    const mine = r.refused.find((x) => info.agentLog.some((e) => e.emailId === "judge" && e.txHash === x.txHash));
    const target = r.explorer ? (mine ? `${r.explorer}/tx/${mine.txHash}#eventlog` : `${r.explorer}/address/${r.vault}#events`) : null;
    $("result-verify").hidden = !target;
    document.querySelector(".result-body").classList.toggle("single", !target);
    if (target) {
      $("result-qr").src = `/api/qr?d=${encodeURIComponent(target)}`;
      $("result-qr").alt = target;
      $("result-link").href = target;
      $("result-link").textContent = `${mine ? t().verifyMine : t().verifyAll} ↗`;
    }
    $("result").hidden = false;
    $("result-close").focus();
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("result").hidden) $("result").hidden = true;
  });
  $("result").addEventListener("click", (e) => {
    if (e.target === $("result")) $("result").hidden = true;
  });

  $("judge-form").addEventListener("submit", (e) => {
    e.preventDefault();
    act(async () => {
      await api("/api/judge", { address: $("judge-addr").value, lang });
      info = await api("/api/info");
      renderReasoning();
    });
  });

  $("scenario").addEventListener("change", (e) => {
    act(async () => {
      info = await api("/api/scenario", { id: e.target.value });
      prefilled = false;
      clearEvents();
      render();
      refreshBalances();
    });
  });

  (async () => {
    renderStatic();
    info = await api("/api/info");
    render();
    refreshBalances();
    connect();
  })();
})();
