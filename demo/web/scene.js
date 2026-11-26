// SPDX-License-Identifier: Apache-2.0
// The vault scene: a live picture of what the vault decides. Presentation only; it never changes a result.
// It watches the activity list the app renders from chain events, so every animation matches a real event.
// Approved payments flow through the vault in teal; refused requests hit its shield and scatter in red,
// with the vault's own reason written beside the impact.
(() => {
  const canvas = document.getElementById("vault-scene");
  if (!canvas) return;
  const g = canvas.getContext("2d");
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let W = 0, H = 0;
  const fit = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  fit();
  window.addEventListener("resize", fit);
  new ResizeObserver(fit).observe(canvas);

  const dark = () => document.body.classList.contains("dark");
  const C = () => dark()
    ? { teal: "94,214,232", red: "255,122,107", ink: "235,250,255", text: "244,248,252", sub: "200,214,230" }
    : { teal: "11,127,145", red: "185,40,30", ink: "23,35,52", text: "23,35,52", sub: "82,96,117" };
  const V = () => ({ x: W * 0.6, y: H * 0.52, r: Math.max(34, Math.min(H * 0.26, 70)) });

  let parts = [], rings = [], labels = [];
  let t = 0, redPulse = 0, tealPulse = 0, shieldHit = 0, paidCount = 0, refusedCount = 0;

  function spawnDust() {
    const v = V();
    if (parts.length < 120 && Math.random() < 0.45) {
      parts.push({ x: -8, y: v.y + (Math.random() - 0.5) * H * 0.8, vx: 0.7 + Math.random() * 0.9, vy: 0, r: 0.7 + Math.random() * 1.3, kind: "dust", life: 1 });
    }
  }

  function refuse(reason, detail) {
    const v = V();
    refusedCount++;
    redPulse = 1; shieldHit = 1;
    window.vault3d?.refuse();
    rings.push({ r: v.r, a: 0.9, col: "red" }, { r: v.r * 0.8, a: 0.6, col: "red", delay: 6 });
    for (let i = 0; i < 70; i++) {
      const a = Math.PI + (Math.random() - 0.5) * 2.2, sp = 1.5 + Math.random() * 5.5;
      parts.push({ x: v.x + Math.cos(a) * (v.r + 8), y: v.y + Math.sin(a) * (v.r + 8), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: 1.2 + Math.random() * 2.4, kind: "red", life: 1 });
    }
    for (let i = 0; i < 22; i++) parts.push({ x: -30 - i * 10, y: v.y + (Math.random() - 0.5) * 6, vx: 9, vy: 0, r: 2.4, kind: "probe", life: 1 });
    labels.push({ title: "Refused", line: reason || "Request does not match the approval", detail: detail || "", col: "red", life: 1, y0: v.y });
  }

  function pay(detail) {
    const v = V();
    paidCount++;
    tealPulse = 1;
    window.vault3d?.pay();
    rings.push({ r: v.r, a: 0.8, col: "teal" });
    for (let i = 0; i < 90; i++) parts.push({ x: v.x + v.r * 0.3, y: v.y + (Math.random() - 0.5) * 12, vx: 2.5 + Math.random() * 4, vy: (Math.random() - 0.5) * 0.8, r: 1.2 + Math.random() * 2, kind: "paid", life: 1 });
    labels.push({ title: "Paid once", line: "Matches the approval", detail: detail || "", col: "teal", life: 1, y0: v.y });
  }

  function glow(x, y, r, rgb, a) {
    if (a <= 0) return;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
  }

  function frame() {
    const c = C(), v = V();
    t += 1;
    g.clearRect(0, 0, W, H);

    // light field
    glow(v.x, v.y, Math.max(W, H) * 0.7, c.teal, window.__vault3d ? 0.04 : (dark() ? 0.13 : 0.07));
    if (redPulse > 0) { glow(v.x, v.y, v.r * 4, c.red, 0.38 * redPulse); redPulse *= 0.955; if (redPulse < 0.02) redPulse = 0; }
    if (tealPulse > 0) { glow(v.x, v.y, v.r * 4, c.teal, 0.45 * tealPulse); tealPulse *= 0.955; if (tealPulse < 0.02) tealPulse = 0; }

    // orbit rings
    for (let k = 0; k < (window.__vault3d ? 0 : 4); k++) {
      g.strokeStyle = `rgba(${c.teal},${(dark() ? 0.45 : 0.3) - k * 0.09 + Math.sin(t / 50 + k) * 0.04})`;
      g.lineWidth = k ? 1 : 2.2;
      g.setLineDash(k === 1 ? [3, 7] : []);
      g.beginPath(); g.arc(v.x, v.y, v.r + 14 + k * 16, t / 400 * (k % 2 ? -1 : 1), t / 400 * (k % 2 ? -1 : 1) + 6.283); g.stroke();
    }
    g.setLineDash([]);

    // shockwave rings
    rings = rings.filter((r) => r.a > 0.02);
    for (const r of rings) {
      if (r.delay) { r.delay--; continue; }
      r.r += 3.2; r.a *= 0.94;
      g.strokeStyle = `rgba(${r.col === "red" ? c.red : c.teal},${r.a})`; g.lineWidth = 2.5;
      g.beginPath(); g.arc(v.x, v.y, r.r, 0, 6.283); g.stroke();
    }

    // shield (left arc flashes red on impact)
    if (shieldHit > 0) {
      g.strokeStyle = `rgba(${c.red},${shieldHit})`; g.lineWidth = 5; g.lineCap = "round";
      g.beginPath(); g.arc(v.x, v.y, v.r + 6, Math.PI - 0.9, Math.PI + 0.9); g.stroke();
      shieldHit *= 0.94; if (shieldHit < 0.02) shieldHit = 0;
    }

    // vault core (the 3D vault draws it when WebGL is available)
    if (!window.__vault3d) {
    g.save(); g.translate(v.x, v.y);
    g.fillStyle = dark() ? "rgba(7,11,20,.85)" : "rgba(255,255,255,.9)";
    g.beginPath(); g.arc(0, 0, v.r, 0, 6.283); g.fill();
    g.strokeStyle = `rgba(${c.teal},.9)`; g.lineWidth = 2.4; g.beginPath(); g.arc(0, 0, v.r, 0, 6.283); g.stroke();
    g.strokeStyle = `rgba(${c.ink},.95)`; g.lineWidth = 2.2; g.beginPath();
    for (let k = 0; k < 7; k++) { const a = k * Math.PI / 3 + Math.PI / 6; g[k ? "lineTo" : "moveTo"](Math.cos(a) * v.r * 0.5, Math.sin(a) * v.r * 0.5); }
    g.stroke();
    g.strokeStyle = `rgb(${c.teal})`; g.lineWidth = 4; g.lineCap = "round"; g.lineJoin = "round";
    g.beginPath(); g.moveTo(-v.r * 0.2, 0); g.lineTo(-v.r * 0.05, v.r * 0.15); g.lineTo(v.r * 0.22, -v.r * 0.15); g.stroke();
    g.restore();
    }

    // particles
    if (!reduce) spawnDust();
    parts = parts.filter((p) => p.life > 0 && p.x < W + 60 && p.x > -80 && p.y > -60 && p.y < H + 60);
    for (const p of parts) {
      if (p.kind === "dust") {
        const dx = v.x - p.x, dy = v.y - p.y, d = Math.hypot(dx, dy) || 1;
        p.vy += (dy / d) * 0.035; p.vy *= 0.98;
        if (d < v.r) p.life = 0;
        g.fillStyle = `rgba(${c.teal},${0.12 + 0.55 * Math.min(1, p.x / v.x)})`;
      } else if (p.kind === "probe") {
        if (p.x > v.x - v.r - 10) { p.life = 0; continue; }
        glow(p.x, p.y, 10, c.red, 0.5);
        g.fillStyle = `rgba(${c.red},1)`;
      } else if (p.kind === "red") {
        p.vx *= 0.955; p.vy *= 0.955; p.life -= 0.011;
        glow(p.x, p.y, p.r * 5, c.red, 0.22 * p.life);
        g.fillStyle = `rgba(${c.red},${p.life})`;
      } else {
        p.life -= 0.005;
        glow(p.x, p.y, p.r * 4, c.teal, 0.22 * p.life);
        g.fillStyle = `rgba(${c.teal},${p.life})`;
      }
      p.x += p.vx; p.y += p.vy;
      g.beginPath(); g.arc(p.x, p.y, p.r, 0, 6.283); g.fill();
    }

    // labels: what the vault decided, written next to the impact
    labels = labels.filter((l) => l.life > 0.01).slice(-1);
    labels.forEach((l, i) => {
      l.life -= 0.0022;
      const a = Math.min(1, l.life * 4);
      const x = 22, y = 40 + i * 70;
      const rgb = l.col === "red" ? c.red : c.teal;
      g.font = "700 30px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      g.fillStyle = `rgba(${rgb},${a})`; g.fillText(l.title, x, y);
      g.font = "500 18px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      g.fillStyle = `rgba(${c.text},${a})`; g.fillText(l.line, x, y + 28);
      if (l.detail) { g.font = "400 14px ui-monospace, SFMono-Regular, Menlo, monospace"; g.fillStyle = `rgba(${c.sub},${a})`; g.fillText(l.detail, x, y + 50); }
    });

    // tallies in the corner
    g.font = "500 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.textAlign = "right";
    g.fillStyle = `rgba(${c.sub},.9)`; g.fillText(`refused ${refusedCount}  ·  paid ${paidCount}`, W - 14, H - 12);
    g.textAlign = "left";

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Follow the activity list: animate only rows that arrive after the page has loaded.
  const list = document.getElementById("events");
  let seen = new Set();
  const loadedAt = performance.now();
  const keyOf = (li) => li.textContent.trim();
  const scan = () => {
    if (!list) return;
    const rows = [...list.children];
    // Rows already on the chain when the page opens are history, not news: no animation for them.
    if (performance.now() - loadedAt < 2000) { rows.forEach((li) => seen.add(keyOf(li))); return; }
    for (const li of rows.slice().reverse()) {
      const k = keyOf(li);
      if (seen.has(k)) continue;
      seen.add(k);
      const why = li.querySelector(".ev-why")?.textContent?.trim();
      const code = li.querySelector(".ev-code")?.textContent?.trim();
      const sub = li.querySelector(".ev-sub")?.textContent?.trim() || "";
      const amount = (sub.match(/^[\d,.]+ test USD/) || [""])[0];
      if (li.classList.contains("refused")) refuse(why || code, amount ? `Without the vault, ${amount} would be gone.` : code);
      else if (li.classList.contains("paid")) pay(amount);
    }
  };
  if (list) new MutationObserver(scan).observe(list, { childList: true });
  setTimeout(scan, 1200);
  // The app also calls these directly; the list watcher is the single source, so they are no-ops.
  window.vaultScene = { refuse() {}, pay() {}, _refuse: refuse, _pay: pay };
})();
