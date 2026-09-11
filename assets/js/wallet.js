/* Cronos Legends — safe wallet connection.
 *
 * - Discovers every injected wallet via EIP-6963 (Crypto.com Onchain, MetaMask, Rabby, Trust,
 *   OKX, …) and falls back to window.ethereum for older wallets.
 * - Connecting only asks for the account; it never asks for signatures, approvals or seed phrases.
 * - Makes sure the wallet is on Cronos (chain 25) before any transaction, adding the network if
 *   the wallet does not know it.
 * - Wallet names are rendered with textContent and icons only through <img src> (EIP-6963 rule).
 */
(function () {
  "use strict";
  const CL = (window.CL = window.CL || {});

  const CRONOS = {
    chainId: "0x19",
    chainName: "Cronos Mainnet",
    nativeCurrency: { name: "Cronos", symbol: "CRO", decimals: 18 },
    rpcUrls: ["https://evm.cronos.org"],
    blockExplorerUrls: ["https://explorer.cronos.org"],
  };

  const wallets = new Map(); // uuid -> { info, provider }
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn(Array.from(wallets.values())));

  window.addEventListener("eip6963:announceProvider", (event) => {
    const d = event.detail;
    if (!d || !d.info || !d.provider) return;
    wallets.set(d.info.uuid || d.info.rdns || d.info.name, { info: d.info, provider: d.provider });
    notify();
  });

  function requestAnnouncements() {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  }

  /** Calls fn(list) now and whenever a wallet announces itself (some announce late). */
  CL.onWallets = function (fn) {
    listeners.add(fn);
    requestAnnouncements();
    setTimeout(() => {
      // Legacy fallback: wallets that do not speak EIP-6963 yet.
      if (!wallets.size && window.ethereum) {
        const injected = Array.isArray(window.ethereum.providers) ? window.ethereum.providers : [window.ethereum];
        injected.forEach((p, i) => {
          const name = p.isDeficonnectProvider ? "Crypto.com Onchain" : p.isRabby ? "Rabby" : p.isMetaMask ? "MetaMask" : p.isTrust ? "Trust Wallet" : "Browser wallet";
          wallets.set("legacy-" + i, { info: { name, icon: "", rdns: "legacy" }, provider: p });
        });
      }
      notify();
    }, 500);
    fn(Array.from(wallets.values()));
    return () => listeners.delete(fn);
  };

  /** Only data: images and https icons are rendered. */
  CL.safeIcon = function (icon) {
    return typeof icon === "string" && /^(data:image\/(png|svg\+xml|webp|jpeg|gif)[;,]|https:\/\/)/i.test(icon) ? icon : "";
  };

  let active = null; // { eip1193, browser, signer, address, info }
  const sessionListeners = new Set();
  CL.onSession = function (fn) {
    sessionListeners.add(fn);
    fn(active);
    return () => sessionListeners.delete(fn);
  };
  const emit = () => sessionListeners.forEach((fn) => fn(active));

  async function ensureCronos(eip1193) {
    let chain = await eip1193.request({ method: "eth_chainId" });
    if (chain === CRONOS.chainId) return;
    try {
      await eip1193.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CRONOS.chainId }] });
    } catch (e) {
      const code = e && (e.code ?? (e.data && e.data.originalError && e.data.originalError.code));
      if (code === 4902 || code === -32603) {
        await eip1193.request({ method: "wallet_addEthereumChain", params: [CRONOS] });
      } else {
        throw e;
      }
    }
    chain = await eip1193.request({ method: "eth_chainId" });
    if (chain !== CRONOS.chainId) throw Object.assign(new Error("Please switch your wallet to Cronos."), { code: "WRONG_CHAIN" });
  }

  CL.connect = async function (wallet) {
    const eip1193 = wallet.provider;
    const accounts = await eip1193.request({ method: "eth_requestAccounts" });
    if (!accounts || !accounts.length) throw new Error("No account selected.");
    await ensureCronos(eip1193);
    const browser = new ethers.BrowserProvider(eip1193, 25);
    const signer = await browser.getSigner();
    active = { eip1193, browser, signer, address: await signer.getAddress(), info: wallet.info };
    try {
      localStorage.setItem("cl-wallet", wallet.info.rdns || wallet.info.name);
    } catch (_) {
      /* storage blocked */
    }
    if (eip1193.on && !eip1193.__clBound) {
      eip1193.__clBound = true;
      eip1193.on("accountsChanged", (accs) => {
        if (!active || active.eip1193 !== eip1193) return;
        if (!accs || !accs.length) return CL.disconnect();
        CL.connect(wallet).catch(() => CL.disconnect());
      });
      eip1193.on("chainChanged", () => {
        if (active && active.eip1193 === eip1193) CL.connect(wallet).catch(() => CL.disconnect());
      });
    }
    emit();
    return active;
  };

  /** Re-checks the chain right before sending a transaction. */
  CL.ensureReady = async function () {
    if (!active) throw Object.assign(new Error("Connect a wallet first."), { code: "NO_WALLET" });
    await ensureCronos(active.eip1193);
    return active;
  };

  CL.disconnect = function () {
    active = null;
    try {
      localStorage.removeItem("cl-wallet");
    } catch (_) {
      /* storage blocked */
    }
    emit();
  };

  CL.session = () => active;

  /** Silently reconnects a wallet the user connected before, if it is still authorised. */
  CL.autoReconnect = function () {
    let remembered = null;
    try {
      remembered = localStorage.getItem("cl-wallet");
    } catch (_) {
      return;
    }
    if (!remembered) return;
    CL.onWallets(async (list) => {
      if (active) return;
      const w = list.find((x) => (x.info.rdns || x.info.name) === remembered);
      if (!w) return;
      try {
        const accs = await w.provider.request({ method: "eth_accounts" });
        if (accs && accs.length) await CL.connect(w);
      } catch (_) {
        /* stay disconnected */
      }
    });
  };

  // ---------------------------------------------------------------------------
  // Mobile: open this page inside a wallet's in-app browser
  // ---------------------------------------------------------------------------

  CL.isMobile = function () {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  };

  CL.walletDeepLinks = function (url) {
    const u = url || location.href;
    const noScheme = u.replace(/^https?:\/\//, "");
    const enc = encodeURIComponent(u);
    return [
      { id: "cdc", name: "Crypto.com Onchain", href: "dfw://dapp/detail?dappUrl=" + enc + "&chainId=25&chainType=eth&source=deficonnect", hint: "Onchain → Discover → paste the link in the search bar" },
      { id: "metamask", name: "MetaMask", href: "https://link.metamask.io/dapp/" + noScheme, hint: "MetaMask → Browser tab → paste the link" },
      { id: "trust", name: "Trust Wallet", href: "https://link.trustwallet.com/open_url?coin_id=10000025&url=" + enc, hint: "Trust → Discover → paste the link" },
      { id: "okx", name: "OKX Wallet", href: "okx://wallet/dapp/url?dappUrl=" + enc, hint: "OKX → Discover → paste the link" },
    ];
  };
})();
