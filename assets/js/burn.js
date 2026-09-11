/* Cronos Legends — burn an NFT, receive CLG.
 *
 * Markup contract (see /burn/index.html):
 *   [data-burn-app]                      root; gets data-wallet="none|connected"
 *   [data-wallet-list] + #tpl-wallet     wallet buttons (fields: icon, name)
 *   [data-wallet-none]                   shown when no browser wallet is found
 *   [data-mobile-links] + #tpl-deeplink  "open in wallet app" links (fields: name, hint)
 *   [data-wallet-connected]              shown when connected (fields: address, wallet-name)
 *   [data-action="disconnect"]
 *   [data-collection="<key>"]            one per collection in burn.json; gets data-status=
 *                                        soon|warming|paused|empty|live|error
 *     [data-stat="payout-clg|payout-usd|reserve|burns-left|burned|clg-price"]
 *     [data-link="redeemer|nft"]         <a> elements, href set to the explorer
 *     [data-nft-grid] + #tpl-nft         the connected wallet's eligible NFTs (fields: image, name, id, payout; action burn)
 *     [data-nft-note]                    message area for the grid (loading / none owned / …)
 *   #burn-dialog (<dialog>)              confirmation + progress; data-step=confirm|pending|success|error
 *     fields: nft-image, nft-name, payout-clg, payout-usd, min-clg, redeemer, nft-contract, tx-link, error, received
 *     #burn-ack checkbox; actions: confirm-burn, close, add-token
 *
 * Safety: one transaction per burn (safeTransferFrom on the NFT contract, straight into the
 * redeemer). No token approvals, no signatures, no seed phrases. The payout floor (minClgOut,
 * 2% below the quote) travels with the transaction so a moving price can never pay less than shown.
 */
(function () {
  "use strict";
  const CL = (window.CL = window.CL || {});
  const SLIPPAGE_BPS = 200n;
  const IPFS_GATEWAYS = ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://w3s.link/ipfs/"];

  const app = document.querySelector("[data-burn-app]");
  if (!app) return;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const setText = (root, sel, text) => $$(sel, root).forEach((el) => (el.textContent = text));
  const state = { cfg: null, cols: {}, dialog: null };

  const MESSAGES = {
    UserRejected: "You cancelled in your wallet. Nothing happened and your NFT is still yours.",
    WarmingUp: "Burns open once the price oracle has a full day of price history. Please check back soon.",
    Stale: "Burns are paused because the price oracle hasn't had a fresh price update. They resume automatically once updates arrive again. Your NFT was not touched.",
    LiquidityTooLow: "Burns are paused automatically: liquidity in the CLG/CRONUS pool is below the safety floor (now, or at some point in the last 24 hours), so the price can't be trusted. They resume on their own once it's back. Your NFT was not touched.",
    PairReservesTooLow: "Burns are paused automatically: one of the pools used to price CLG is too thin right now. Your NFT was not touched.",
    ReserveTooLow: "The reserve doesn't hold enough CLG for this burn right now. Your NFT was not touched.",
    PayoutBelowMinimum: "The CLG price moved while you were confirming, so the payout fell below the minimum you were shown. Nothing happened — refresh and try again.",
    TokenNotEligible: "This token ID isn't part of the burn program.",
    AlreadyRedeemed: "This NFT has already been burned.",
    TransferFromIncorrectOwner: "This NFT isn't in your connected wallet any more.",
    ERC721IncorrectOwner: "This NFT isn't in your connected wallet any more.",
    TransferToNonERC721ReceiverImplementer: "The burn contract did not accept this NFT. Nothing happened — refresh and try again.",
    ERC721InvalidReceiver: "The burn contract did not accept this NFT. Nothing happened — refresh and try again.",
    CONFIG: "The burn contract on this page doesn't match its published settings, so burning is switched off for safety. Please tell the team on Discord.",
    WRONG_CHAIN: "Please switch your wallet to the Cronos network and try again.",
    NO_WALLET: "Connect a wallet first.",
  };
  const friendly = (err) => {
    const name = CL.errorName(err) || (err && err.code);
    if (name && MESSAGES[name]) return MESSAGES[name];
    const msg = (err && (err.shortMessage || err.reason || err.message)) || "Something went wrong.";
    if (/insufficient funds/i.test(msg)) return "Your wallet doesn't have enough CRO to pay the network fee (a burn costs well under 1 CRO).";
    return msg.length > 220 ? msg.slice(0, 220) + "…" : msg;
  };

  // ---------------------------------------------------------------------------
  // Program status per collection
  // ---------------------------------------------------------------------------

  async function loadCollection(col) {
    const el = $('[data-collection="' + col.key + '"]');
    if (!el) return;
    const c = (state.cols[col.key] = state.cols[col.key] || { col, el, owned: [], images: {} });
    if (col.redeemer) {
      $$('[data-link="redeemer"]', el).forEach(async (a) => {
        a.href = await CL.explorer("address", col.redeemer);
        a.textContent = CL.short(col.redeemer);
      });
    }
    if (col.nft) $$('[data-link="nft"]', el).forEach(async (a) => (a.href = await CL.explorer("address", col.nft)));
    if (!col.redeemer || !col.nft) {
      el.dataset.status = "soon";
      return;
    }
    try {
      if (!c.verified) {
        c.verified = await verifyRedeemer(col);
        if (!c.verified) {
          el.dataset.status = "error";
          el.dataset.reason = "CONFIG";
          return;
        }
      }
      const r = await CL.read(async (p) => {
        const red = CL.contract(col.redeemer, "redeemer", p);
        const [reserve, burned] = await Promise.all([red.reserveBalance(), red.totalRedeemed()]);
        let quote = null;
        let quoteError = null;
        try {
          quote = await red.quote();
        } catch (e) {
          quoteError = CL.errorName(e) || "error";
        }
        return { reserve, burned, quote, quoteError };
      });
      Object.assign(c, r);
      el.dataset.reason = r.quoteError || "";
      setText(el, '[data-stat="reserve"]', CL.fmtUnits(r.reserve, 18, 4) + " CLG");
      setText(el, '[data-stat="burned"]', r.burned.toString());
      if (r.quote) {
        const [amount, price] = r.quote;
        const usd = Number(ethers.formatUnits(amount, 18)) * Number(ethers.formatUnits(price, 18));
        setText(el, '[data-stat="payout-clg"]', CL.fmtUnits(amount, 18, 5) + " CLG");
        setText(el, '[data-stat="payout-usd"]', CL.usd(usd));
        setText(el, '[data-stat="clg-price"]', CL.usd(Number(ethers.formatUnits(price, 18))));
        const left = amount > 0n ? r.reserve / amount : 0n;
        setText(el, '[data-stat="burns-left"]', left.toString());
        el.dataset.status = left < 1n ? "empty" : "live";
      } else {
        el.dataset.status = r.quoteError === "WarmingUp" ? "warming" : ["Stale", "LiquidityTooLow", "PairReservesTooLow"].includes(r.quoteError) ? "paused" : "error";
        setText(el, '[data-stat="payout-usd"]', "$" + col.usdPerNft);
      }
      setText(el, '[data-stat="reason"]', r.quoteError && MESSAGES[r.quoteError] ? MESSAGES[r.quoteError] : "");
    } catch (e) {
      console.warn("burn: status", col.key, e);
      el.dataset.status = "error";
    }
  }

  /** The redeemer must be a contract whose immutable settings match what this page publishes. A wrong
   *  address in the config could otherwise send an NFT somewhere it can never come back from. */
  async function verifyRedeemer(col) {
    try {
      return await CL.read(async (p) => {
        if ((await p.getCode(col.redeemer)) === "0x") return false;
        const red = CL.contract(col.redeemer, "redeemer", p);
        const [nft, clg, oracle, owner, usdPerNft, minId, maxId] = await Promise.all([red.collection(), red.clg(), red.oracle(), red.owner(), red.USD_PER_NFT(), red.MIN_TOKEN_ID(), red.MAX_TOKEN_ID()]);
        const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
        return (
          same(nft, col.nft) &&
          same(clg, state.cfg.clg) &&
          !!state.cfg.oracle &&
          same(oracle, state.cfg.oracle) &&
          owner === ethers.ZeroAddress &&
          usdPerNft === ethers.parseUnits(String(col.usdPerNft), 18) &&
          Number(minId) === col.minTokenId &&
          Number(maxId) === col.maxTokenId
        );
      });
    } catch (e) {
      console.warn("burn: verify", col.key, e);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Wallet UI
  // ---------------------------------------------------------------------------

  function renderWallets(list) {
    const box = $("[data-wallet-list]");
    const tpl = $("#tpl-wallet");
    if (!box || !tpl) return;
    box.textContent = "";
    list.forEach((w) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      const icon = $('[data-field="icon"]', node);
      const src = CL.safeIcon(w.info.icon);
      if (icon) {
        if (src) icon.src = src;
        else icon.remove();
      }
      setText(node, '[data-field="name"]', w.info.name || "Wallet");
      node.addEventListener("click", async () => {
        node.disabled = true;
        try {
          await CL.connect(w);
        } catch (e) {
          toast(friendly(e));
        } finally {
          node.disabled = false;
        }
      });
      box.appendChild(node);
    });
    $$("[data-wallet-none]").forEach((el) => (el.hidden = list.length > 0));
  }

  function renderDeepLinks() {
    const box = $("[data-mobile-links]");
    const tpl = $("#tpl-deeplink");
    if (!box || !tpl) return;
    box.textContent = "";
    CL.walletDeepLinks(location.href).forEach((d) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.href = d.href;
      setText(node, '[data-field="name"]', d.name);
      setText(node, '[data-field="hint"]', d.hint);
      box.appendChild(node);
    });
  }

  function onSession(session) {
    app.dataset.wallet = session ? "connected" : "none";
    setText(document, '[data-wallet-connected] [data-field="address"]', session ? CL.short(session.address) : "");
    setText(document, '[data-wallet-connected] [data-field="wallet-name"]', session ? session.info.name : "");
    Object.values(state.cols).forEach((c) => renderOwned(c));
    if (session) loadOwned(session.address);
  }

  // ---------------------------------------------------------------------------
  // The wallet's NFTs
  // ---------------------------------------------------------------------------

  async function ownedTokenIds(col, owner) {
    return CL.read(async (p) => {
      if (col.standard === "erc721a") {
        const nft = CL.contract(col.nft, "erc721a", p);
        return (await nft.tokensOfOwner(owner)).map((x) => Number(x));
      }
      // Plain ERC-721 without enumeration: ask ownerOf for every eligible ID in one Multicall3 call.
      const mc = new ethers.Contract("0xcA11bde05977b3631167028862bE2a173976CA11", ["function aggregate3((address target,bool allowFailure,bytes callData)[]) view returns ((bool success,bytes returnData)[])"], p);
      const iface = new ethers.Interface(CL.ABI.erc721);
      const ids = [];
      for (let i = col.minTokenId; i <= col.maxTokenId; i++) ids.push(i);
      const res = await mc.aggregate3(ids.map((id) => ({ target: col.nft, allowFailure: true, callData: iface.encodeFunctionData("ownerOf", [id]) })));
      return ids.filter((id, i) => res[i].success && iface.decodeFunctionResult("ownerOf", res[i].returnData)[0].toLowerCase() === owner.toLowerCase());
    });
  }

  async function loadOwned(owner) {
    for (const c of Object.values(state.cols)) {
      // Collections without a claim contract yet are still listed, so holders can check they're ready.
      if (!c.col.nft || c.col.minTokenId == null) continue;
      c.loading = true;
      renderOwned(c);
      try {
        const ids = await ownedTokenIds(c.col, owner);
        c.owned = ids.filter((id) => id >= c.col.minTokenId && id <= c.col.maxTokenId).sort((a, b) => a - b);
      } catch (e) {
        console.warn("burn: owned", c.col.key, e);
        c.owned = [];
        c.ownedError = true;
      }
      c.loading = false;
      renderOwned(c);
    }
  }

  function renderOwned(c) {
    const grid = $("[data-nft-grid]", c.el);
    const note = $("[data-nft-note]", c.el);
    if (!grid) return;
    grid.textContent = "";
    const session = CL.session();
    const say = (t) => note && ((note.textContent = t), (note.hidden = !t));
    if (!c.col.nft || c.col.minTokenId == null) return say("");
    if (!session) return say("Connect your wallet to see which of your NFTs " + (c.col.redeemer ? "you can burn." : "will be eligible."));
    if (c.loading) return say("Looking for your NFTs…");
    if (c.ownedError) return say("Couldn't load your NFTs right now. Please refresh in a moment.");
    if (!c.owned.length) return say("This wallet holds no " + c.col.name + " NFTs. If yours are in the Crypto.com NFT app, withdraw them to your Cronos wallet first.");
    say(c.col.redeemer ? "" : "You're ready: " + c.owned.length + " NFT" + (c.owned.length === 1 ? "" : "s") + " in this wallet will be eligible when burning opens.");
    const tpl = $("#tpl-nft");
    c.owned.forEach((id) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      setText(node, '[data-field="name"]', c.col.name);
      setText(node, '[data-field="id"]', "#" + id);
      setText(node, '[data-field="payout"]', c.quote ? CL.fmtUnits(c.quote[0], 18, 5) + " CLG" : "$" + c.col.usdPerNft + " in CLG");
      if (!c.col.redeemer) setText(node, '[data-action="burn"]', "Opens soon");
      const img = $('[data-field="image"]', node);
      if (img) {
        if (c.images[id]) img.src = c.images[id];
        else lazyImage(c, id, img);
      }
      const btn = $('[data-action="burn"]', node);
      if (btn) {
        btn.disabled = c.el.dataset.status !== "live";
        btn.addEventListener("click", () => openDialog(c, id, img && img.src));
      }
      grid.appendChild(node);
    });
  }

  /** Light refresh: payout labels and button states only, without rebuilding the grid. */
  function updateOwned(c) {
    const grid = $("[data-nft-grid]", c.el);
    if (!grid) return;
    $$('[data-field="payout"]', grid).forEach((el) => (el.textContent = c.quote ? CL.fmtUnits(c.quote[0], 18, 5) + " CLG" : "$" + c.col.usdPerNft + " in CLG"));
    $$('[data-action="burn"]', grid).forEach((b) => (b.disabled = c.el.dataset.status !== "live"));
  }

  const ipfs = (uri, i = 0) => (uri && uri.startsWith("ipfs://") ? IPFS_GATEWAYS[i] + uri.slice(7).replace(/^ipfs\//, "") : uri);

  // Artwork is fetched only for cards on screen, three at a time, so a wallet holding hundreds of
  // NFTs doesn't flood the public RPC (it rate-limits bursts) or the IPFS gateways.
  const imageQueue = [];
  let imagesInFlight = 0;
  function pumpImages() {
    while (imagesInFlight < 3 && imageQueue.length) {
      const job = imageQueue.shift();
      imagesInFlight++;
      loadImage(job.c, job.id, job.img).finally(() => {
        imagesInFlight--;
        pumpImages();
      });
    }
  }
  const imageObserver =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) =>
            entries.forEach((en) => {
              if (!en.isIntersecting) return;
              imageObserver.unobserve(en.target);
              const job = en.target.__imgJob;
              if (job) {
                imageQueue.push(job);
                pumpImages();
              }
            }),
          { rootMargin: "200px" }
        )
      : null;
  function lazyImage(c, id, img) {
    if (!imageObserver) return loadImage(c, id, img);
    img.__imgJob = { c, id, img };
    imageObserver.observe(img);
  }

  async function loadImage(c, id, img) {
    const col = c.col;
    try {
      const uri = await CL.read((p) => CL.contract(col.nft, "erc721", p).tokenURI(id));
      let meta = null;
      for (let i = 0; i < IPFS_GATEWAYS.length && !meta; i++) {
        try {
          const r = await fetch(ipfs(uri, i));
          if (r.ok) meta = await r.json();
        } catch (_) {
          /* try next gateway */
        }
      }
      const src = meta && ipfs(meta.image || meta.image_url);
      if (src && /^https:\/\//.test(src)) {
        img.src = src;
        c.images[id] = src;
        img.onerror = () => {
          const next = ipfs(meta.image || meta.image_url, 1);
          if (img.src !== next) img.src = next;
        };
      }
      if (meta && meta.name) img.alt = String(meta.name);
    } catch (_) {
      /* keep the placeholder artwork */
    }
  }

  // ---------------------------------------------------------------------------
  // Burn dialog
  // ---------------------------------------------------------------------------

  const dialog = $("#burn-dialog");

  const EYEBROW = { confirm: "You're about to burn", pending: "Burning", success: "Burned", error: "Not burned" };
  function step(name) {
    if (!dialog) return;
    dialog.dataset.step = name;
    setText(dialog, '[data-field="dialog-eyebrow"]', EYEBROW[name] || "");
  }

  async function openDialog(c, tokenId, imageSrc) {
    if (!dialog) return;
    state.dialog = { c, tokenId };
    const ack = $("#burn-ack", dialog);
    if (ack) ack.checked = false;
    setText(dialog, '[data-field="nft-name"]', c.col.name + " #" + tokenId);
    const img = $('[data-field="nft-image"]', dialog);
    if (img && imageSrc) img.src = imageSrc;
    setText(dialog, '[data-field="redeemer"]', c.col.redeemer);
    setText(dialog, '[data-field="nft-contract"]', c.col.nft);
    $$('[data-field="tx-link"]', dialog).forEach((link) => (link.hidden = true));
    setText(dialog, '[data-field="error"]', "");
    try {
      await refreshQuote();
      step("confirm");
      syncConfirm();
    } catch (e) {
      setText(dialog, '[data-field="error"]', friendly(e));
      step("error");
    }
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  async function refreshQuote() {
    const { c } = state.dialog;
    const quote = await CL.read((p) => CL.contract(c.col.redeemer, "redeemer", p).quote());
    const [amount, price] = quote;
    const min = amount - (amount * SLIPPAGE_BPS) / 10000n;
    state.dialog.amount = amount;
    state.dialog.min = min;
    const usd = Number(ethers.formatUnits(amount, 18)) * Number(ethers.formatUnits(price, 18));
    setText(dialog, '[data-field="payout-clg"]', CL.fmtUnits(amount, 18, 5) + " CLG");
    setText(dialog, '[data-field="payout-usd"]', "≈ " + CL.usd(usd));
    setText(dialog, '[data-field="min-clg"]', CL.fmtUnits(min, 18, 5) + " CLG");
  }

  function syncConfirm() {
    const btn = dialog && $('[data-action="confirm-burn"]', dialog);
    const ack = dialog && $("#burn-ack", dialog);
    if (btn) btn.disabled = !(ack && ack.checked);
  }

  async function confirmBurn() {
    const { c, tokenId } = state.dialog;
    try {
      if (!c.verified) throw Object.assign(new Error("config"), { code: "CONFIG" });
      const session = await CL.ensureReady();
      await refreshQuote();
      const nft = CL.contract(c.col.nft, "erc721", session.signer);
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [state.dialog.min]);
      // Dry run first: any reason the burn would fail surfaces here, before the wallet prompt.
      const gas = await nft.safeTransferFrom.estimateGas(session.address, c.col.redeemer, tokenId, data);
      step("pending");
      setText(dialog, '[data-field="tx-status"]', "Confirm the transaction in your wallet…");
      // Headroom: if an hourly oracle checkpoint falls due between the estimate and inclusion, the
      // burn also records it (~100k gas). Unused gas is refunded, and Cronos gas is cheap.
      const tx = await nft.safeTransferFrom(session.address, c.col.redeemer, tokenId, data, { gasLimit: (gas * 120n) / 100n + 150000n });
      const txUrl = await CL.explorer("tx", tx.hash);
      $$('[data-field="tx-link"]', dialog).forEach((link) => {
        link.href = txUrl;
        link.hidden = false;
      });
      setText(dialog, '[data-field="tx-status"]', "Burning… this usually takes a few seconds.");
      const receipt = await tx.wait();
      const iface = new ethers.Interface(CL.ABI.redeemer);
      let received = state.dialog.amount;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== c.col.redeemer.toLowerCase()) continue;
        try {
          const ev = iface.parseLog(log);
          if (ev && ev.name === "Redeemed") received = ev.args.clgAmount;
        } catch (_) {
          /* other event */
        }
      }
      setText(dialog, '[data-field="received"]', CL.fmtUnits(received, 18, 5) + " CLG");
      step("success");
      celebrate();
      c.owned = c.owned.filter((id) => id !== tokenId);
      loadCollection(c.col).then(() => renderOwned(c));
    } catch (e) {
      console.warn("burn failed", e);
      setText(dialog, '[data-field="error"]', friendly(e));
      step("error");
    }
  }

  async function addTokenToWallet() {
    const session = CL.session();
    if (!session) return;
    try {
      await session.eip1193.request({
        method: "wallet_watchAsset",
        params: { type: "ERC20", options: { address: state.cfg.clg, symbol: "CLG", decimals: 18, image: location.origin + "/assets/img/clg-256.png" } },
      });
    } catch (_) {
      /* user said no */
    }
  }

  function closeDialog() {
    if (!dialog) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  // ---------------------------------------------------------------------------
  // Little joys
  // ---------------------------------------------------------------------------

  function celebrate() {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const colors = ["#f2b93b", "#ff7a45", "#4d9fff", "#3ecf8e", "#ff4d6d"];
    const layer = document.createElement("div");
    layer.setAttribute("aria-hidden", "true");
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:9999";
    for (let i = 0; i < 90; i++) {
      const s = document.createElement("i");
      const size = 6 + Math.random() * 8;
      s.style.cssText = `position:absolute;left:${Math.random() * 100}%;top:-20px;width:${size}px;height:${size * 0.6}px;background:${colors[i % colors.length]};border-radius:2px;opacity:.95;transform:rotate(${Math.random() * 360}deg)`;
      s.animate(
        [{ transform: s.style.transform + " translateY(0)" }, { transform: `rotate(${Math.random() * 720}deg) translate(${(Math.random() - 0.5) * 200}px, ${window.innerHeight + 60}px)` }],
        { duration: 1800 + Math.random() * 1600, easing: "cubic-bezier(.2,.6,.4,1)", fill: "forwards" }
      );
      layer.appendChild(s);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 3800);
  }

  function toast(text) {
    const t = document.createElement("div");
    t.className = "cl-toast";
    t.setAttribute("role", "status");
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  /** Puts the deployed contract addresses into the static rules block. */
  async function fillRules() {
    const chip = async (addr) => {
      const a = document.createElement("a");
      a.href = await CL.explorer("address", addr);
      a.rel = "noopener";
      a.target = "_blank";
      const code = document.createElement("code");
      code.textContent = addr;
      a.appendChild(code);
      return a;
    };
    for (const col of state.cfg.collections) {
      if (!col.redeemer) continue;
      for (const el of $$('[data-rules-redeemer="' + col.key + '"]')) {
        el.textContent = "";
        el.appendChild(await chip(col.redeemer));
      }
    }
    if (state.cfg.oracle) {
      for (const el of $$("[data-rules-oracle]")) {
        el.textContent = "";
        el.appendChild(await chip(state.cfg.oracle));
      }
    }
  }

  async function boot() {
    state.cfg = await CL.config();
    fillRules();
    await Promise.all(state.cfg.collections.map(loadCollection));
    CL.onWallets(renderWallets);
    renderDeepLinks();
    CL.onSession(onSession);
    CL.autoReconnect();

    $$('[data-action="disconnect"]').forEach((b) => b.addEventListener("click", () => CL.disconnect()));
    if (dialog) {
      const ack = $("#burn-ack", dialog);
      if (ack) ack.addEventListener("change", syncConfirm);
      $$('[data-action="confirm-burn"]', dialog).forEach((b) => b.addEventListener("click", confirmBurn));
      $$('[data-action="close"]', dialog).forEach((b) => b.addEventListener("click", closeDialog));
      $$('[data-action="add-token"]', dialog).forEach((b) => b.addEventListener("click", addTokenToWallet));
      dialog.addEventListener("cancel", (e) => {
        if (dialog.dataset.step === "pending") e.preventDefault();
      });
    }
    // Keep payouts fresh while the page is open.
    setInterval(() => {
      if (document.hidden) return;
      state.cfg.collections.forEach((col) => loadCollection(col).then(() => state.cols[col.key] && updateOwned(state.cols[col.key])));
    }, 60000);
  }

  boot().catch((e) => console.error("burn: boot failed", e));
})();
