// SPDX-License-Identifier: Apache-2.0
// Phone approval page. Plain browser JavaScript, no build step. The wallet signs the
// EIP-712 approval with eth_signTypedData_v4; only the signature is sent to the server.
(() => {
  const $ = (id) => document.getElementById(id);
  let current = null;

  const msg = (text, cls = "") => {
    $("msg").textContent = text;
    $("msg").className = `msg ${cls}`;
  };
  const fmt = (n) => Number(n).toLocaleString("en-GB", { maximumFractionDigits: 2 });

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
    $("sign").disabled = !d;
    if (!d) return;
    $("d-payee").textContent = d.payee;
    $("d-recipient").textContent = d.recipient.slice(2).match(/.{1,4}/g).join(" ").replace(/^/, "0x ");
    $("d-amount").textContent = `up to ${fmt(d.amount)} test dollars`;
    $("d-fiat").textContent = d.fiat ? `≈ ${fmt(Math.round(d.fiat.value))} ${d.fiat.fiat} at the CoinMarketCap rate, ${String(d.fiat.lastUpdated).slice(11, 16)} UTC` : "";
    $("d-uses").textContent = d.uses === 1 ? "Once" : `${d.uses} times`;
    $("d-code").textContent = `${d.digest.slice(2, 6)} ${d.digest.slice(6, 10)} … ${d.digest.slice(-4)}`.toUpperCase();
    $("d-expiry").textContent = new Date(Number(d.expiry) * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
    msg("");
  }

  async function ensureChain(eth, chainId) {
    const hex = `0x${chainId.toString(16)}`;
    const now = await eth.request({ method: "eth_chainId" });
    if (now === hex) return;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      if (e && e.code === 4902) {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: hex,
            chainName: "BNB Smart Chain Testnet",
            nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
            rpcUrls: ["https://bsc-testnet-rpc.publicnode.com"],
            blockExplorerUrls: ["https://testnet.bscscan.com"],
          }],
        });
      } else {
        throw e;
      }
    }
  }

  async function sign() {
    const eth = window.ethereum;
    if (!eth) {
      msg("No wallet found. Open this page in your wallet app's browser.", "err");
      return;
    }
    $("sign").disabled = true;
    try {
      const [account] = await eth.request({ method: "eth_requestAccounts" });
      await ensureChain(eth, current.draft.chainId);
      msg("Check the details in your wallet, then sign.");
      const signature = await eth.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(current.typedData)] });
      const r = await api("/api/phone/sign", { signature });
      msg("");
      $("done-sum").textContent = `${current.draft.payee}, up to ${fmt(current.draft.amount)} test dollars, ${current.draft.uses === 1 ? "once" : current.draft.uses + " times"}.`;
      $("done").hidden = false;
      $("card").hidden = true;
      (document.getElementById("sign") || document.getElementById("approve")).hidden = true;
      $("reload").hidden = true;
      
    } catch (e) {
      msg(e && e.message ? e.message : String(e), "err");
      $("sign").disabled = false;
    }
  }

  $("sign").addEventListener("click", sign);
  $("reload").addEventListener("click", load);
  load();
})();
