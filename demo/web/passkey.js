// SPDX-License-Identifier: Apache-2.0
// Passkey approval page. Plain browser JavaScript, no build step.
// Registration prints the passkey's public key (x, y) for `npm run add-passkey`.
// Approval asks the device for a fingerprint-verified assertion over the vault's approval
// digest and sends only the assertion to the server.
(() => {
  const $ = (id) => document.getElementById(id);
  let current = null;
  const STORE = "seal-demo-passkey-id";

  const msg = (text, cls = "") => {
    $("msg").textContent = text;
    $("msg").className = `msg ${cls}`;
  };
  const fmt = (n) => Number(n).toLocaleString("en-GB", { maximumFractionDigits: 2 });
  const hex = (buf) => "0x" + Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  const fromHex = (h) => new Uint8Array(h.replace(/^0x/, "").match(/../g).map((x) => parseInt(x, 16)));
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

  async function api(path, body) {
    const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }

  async function load() {
    try {
      current = await api("/api/phone/draft");
    } catch (e) {
      msg(e.message, "err");
      return;
    }
    const d = current.draft;
    $("empty").hidden = !!d;
    $("details").hidden = !d;
    $("approve").disabled = !d;
    if (!d) return;
    $("d-payee").textContent = d.payee;
    $("d-recipient").textContent = d.recipient.slice(2).match(/.{1,4}/g).join(" ").replace(/^/, "0x ");
    $("d-amount").textContent = `up to ${fmt(d.amount)} test dollars`;
    $("d-uses").textContent = d.uses === 1 ? "Once" : `${d.uses} times`;
    $("d-code").textContent = `${d.digest.slice(2, 6)} ${d.digest.slice(6, 10)} … ${d.digest.slice(-4)}`.toUpperCase();
    $("d-expiry").textContent = new Date(Number(d.expiry) * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  }

  async function register() {
    if (!window.PublicKeyCredential) return msg("This browser does not support passkeys.", "err");
    try {
      const cred = await navigator.credentials.create({
        publicKey: {
          rp: { name: "Seal demo", id: location.hostname },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "approver", displayName: "Payment approver" },
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
          timeout: 60000,
        },
      });
      const spki = new Uint8Array(cred.response.getPublicKey());
      const xy = spki.slice(spki.length - 64);
      const x = hex(xy.slice(0, 32));
      const y = hex(xy.slice(32));
      try {
        localStorage.setItem(STORE, b64url(cred.rawId));
      } catch {}
      $("setup").hidden = false;
      $("setup").textContent = `Passkey registered on ${location.hostname}. Run once on the laptop:\n\nnpm run add-passkey -- ${x} ${y} ${location.hostname}`;
      msg("Passkey created. Run the command shown below, then approve.", "ok");
    } catch (e) {
      msg(e && e.message ? e.message : String(e), "err");
    }
  }

  async function approve() {
    const d = current && current.draft;
    if (!d) return;
    $("approve").disabled = true;
    try {
      let id = null;
      try {
        id = localStorage.getItem(STORE);
      } catch {}
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: fromHex(d.digest),
          rpId: location.hostname,
          userVerification: "required",
          allowCredentials: id ? [{ type: "public-key", id: fromB64url(id) }] : [],
          timeout: 60000,
        },
      });
      const r = assertion.response;
      const out = await api("/api/passkey/sign", {
        rpId: location.hostname,
        authenticatorData: hex(r.authenticatorData),
        clientDataJSON: new TextDecoder().decode(r.clientDataJSON),
        signature: hex(r.signature),
      });
      msg("");
      $("done-sum").textContent = `${current.draft.payee}, up to ${fmt(current.draft.amount)} test dollars, ${current.draft.uses === 1 ? "once" : current.draft.uses + " times"}.`;
      $("done").hidden = false;
      $("card").hidden = true;
      (document.getElementById("sign") || document.getElementById("approve")).hidden = true;
      $("reload").hidden = true;
      
    } catch (e) {
      msg(e && e.message ? e.message : String(e), "err");
      $("approve").disabled = false;
    }
  }

  if (new URLSearchParams(location.search).get("setup") === "1") $("setup-block").hidden = false;
  $("register").addEventListener("click", register);
  $("approve").addEventListener("click", approve);
  $("reload").addEventListener("click", load);
  load();
})();
