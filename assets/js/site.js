/* Cronos Legends — shared page behaviour: mobile menu, copy buttons, footer year, reveal-on-scroll,
 * card tilt, reading progress, toasts, and live numbers ([data-live]) when chain-lite.js is loaded.
 * Everything degrades to plain HTML without JavaScript. */
(function () {
  "use strict";
  document.documentElement.classList.add("js");
  const CL = (window.CL = window.CL || {});
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------- toast
  CL.toast =
    CL.toast ||
    function (text) {
      const t = document.createElement("div");
      t.className = "cl-toast";
      t.setAttribute("role", "status");
      t.textContent = text;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3800);
    };

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  ready(() => {
    // -------------------------------------------------------------- mobile menu
    const sheet = document.getElementById("site-sheet");
    const openBtn = document.querySelector("[data-menu-open]");
    if (sheet && openBtn) {
      const closeBtn = sheet.querySelector("[data-menu-close]");
      const focusables = () => Array.from(sheet.querySelectorAll("a, button"));
      const open = () => {
        sheet.hidden = false;
        document.body.classList.add("sheet-open");
        openBtn.setAttribute("aria-expanded", "true");
        (closeBtn || focusables()[0]).focus();
      };
      const close = () => {
        sheet.hidden = true;
        document.body.classList.remove("sheet-open");
        openBtn.setAttribute("aria-expanded", "false");
        openBtn.focus();
      };
      openBtn.addEventListener("click", open);
      if (closeBtn) closeBtn.addEventListener("click", close);
      sheet.addEventListener("click", (e) => {
        if (e.target.closest("a")) close();
      });
      document.addEventListener("keydown", (e) => {
        if (sheet.hidden) return;
        if (e.key === "Escape") close();
        if (e.key === "Tab") {
          const f = focusables();
          if (!f.length) return;
          if (e.shiftKey && document.activeElement === f[0]) {
            e.preventDefault();
            f[f.length - 1].focus();
          } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
            e.preventDefault();
            f[0].focus();
          }
        }
      });
    }

    // -------------------------------------------------------------- copy buttons
    document.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-copy]");
      if (!btn) return;
      const value = btn.getAttribute("data-copy");
      try {
        await navigator.clipboard.writeText(value);
        const chip = btn.closest(".addr");
        if (chip) {
          chip.classList.add("copied");
          setTimeout(() => chip.classList.remove("copied"), 1600);
        }
        CL.toast(/^0x[0-9a-fA-F]{40}$/.test(value) ? "Copied. Always check the first and last 4 characters." : "Copied.");
      } catch (_) {
        CL.toast("Couldn't copy. Select the text and copy it manually.");
      }
    });

    // -------------------------------------------------------------- footer year
    document.querySelectorAll("[data-year]").forEach((el) => (el.textContent = String(new Date().getFullYear())));

    // -------------------------------------------------------------- reveal on scroll
    const reveals = document.querySelectorAll(".reveal");
    if (reveals.length && "IntersectionObserver" in window && !reduceMotion) {
      const io = new IntersectionObserver(
        (entries) =>
          entries.forEach((en) => {
            if (en.isIntersecting) {
              en.target.classList.add("is-in");
              io.unobserve(en.target);
            }
          }),
        { rootMargin: "0px 0px -8% 0px" }
      );
      reveals.forEach((el) => io.observe(el));
    } else {
      reveals.forEach((el) => el.classList.add("is-in"));
    }

    // -------------------------------------------------------------- tilt
    if (!reduceMotion && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      document.querySelectorAll(".tilt").forEach((el) => {
        el.addEventListener("pointermove", (e) => {
          const r = el.getBoundingClientRect();
          el.style.setProperty("--ry", ((e.clientX - r.left) / r.width - 0.5) * 6 + "deg");
          el.style.setProperty("--rx", (0.5 - (e.clientY - r.top) / r.height) * 6 + "deg");
        });
        el.addEventListener("pointerleave", () => {
          el.style.setProperty("--rx", "0deg");
          el.style.setProperty("--ry", "0deg");
        });
      });
    }

    // -------------------------------------------------------------- hero card shuffle
    // The three fanned hero cards take turns in front: every few seconds the left card glides to
    // the centre. Clicking a side card brings it forward. Pauses on hover, off screen and in
    // background tabs; no automatic motion for people who prefer reduced motion.
    document.querySelectorAll(".hero-art").forEach((art) => {
      const cards = Array.from(art.querySelectorAll(".card-art"));
      if (cards.length !== 3) return;
      cards.forEach((c) => c.classList.remove("bob"));
      let slots = { left: cards[0], center: cards[2], right: cards[1] };
      const apply = () => {
        Object.entries(slots).forEach(([pos, el]) => {
          el.classList.remove("pos-left", "pos-center", "pos-right");
          el.classList.add("pos-" + pos);
        });
      };
      apply();

      let timer = null;
      let onScreen = true;
      let hovering = false;
      const stop = () => {
        clearInterval(timer);
        timer = null;
      };
      const start = () => {
        if (reduceMotion || timer || !onScreen || hovering || document.hidden) return;
        timer = setInterval(() => {
          slots = { left: slots.right, center: slots.left, right: slots.center };
          apply();
        }, 5000);
      };

      cards.forEach((el) =>
        el.addEventListener("click", () => {
          if (slots.center === el) return;
          slots = slots.left === el ? { left: slots.right, center: el, right: slots.center } : { left: slots.center, center: el, right: slots.left };
          apply();
          stop();
          start();
        })
      );
      art.addEventListener("pointerenter", () => {
        hovering = true;
        stop();
      });
      art.addEventListener("pointerleave", () => {
        hovering = false;
        start();
      });
      document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
      if ("IntersectionObserver" in window) {
        new IntersectionObserver(([en]) => {
          onScreen = en.isIntersecting;
          onScreen ? start() : stop();
        }).observe(art);
      }
      start();
    });

    // -------------------------------------------------------------- reading progress
    const bar = document.querySelector(".progress");
    if (bar) {
      const onScroll = () => {
        const h = document.documentElement;
        const p = h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight);
        bar.style.setProperty("--p", Math.min(1, Math.max(0, p)).toFixed(4));
      };
      document.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    }

    liveNumbers();
  });

  // ---------------------------------------------------------------- live numbers
  function set(key, text) {
    document.querySelectorAll('[data-live="' + key + '"]').forEach((el) => {
      el.textContent = text;
      el.classList.remove("is-loading");
    });
  }

  function countUp(key, value, format) {
    const els = document.querySelectorAll('[data-live="' + key + '"]');
    if (!els.length) return;
    // Background tabs don't run animation frames, so show the final number straight away there.
    if (reduceMotion || document.hidden || !isFinite(value)) return set(key, format(value));
    const start = performance.now();
    const dur = 900;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      set(key, format(value * eased));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  async function liveNumbers() {
    if (!document.querySelector("[data-live]") || !CL.lite) return;
    const has = (k) => !!document.querySelector('[data-live="' + k + '"]');
    const usd = (n) => "$" + CL.fmt(n, n < 100 ? 2 : 0, n < 100 ? 2 : 0);
    let cfg;
    try {
      cfg = await CL.config();
    } catch (_) {
      return;
    }
    const jobs = [];

    // NFTs sent to the burn address, per collection and in total.
    const burnable = cfg.collections.filter((c) => c.nft);
    if (has("burned") || burnable.some((c) => has("burned-" + c.key))) {
      jobs.push(
        Promise.all(burnable.map((c) => CL.lite.balanceOf(c.nft, cfg.burnAddress).then((b) => [c.key, Number(b)])))
          .then((rows) => {
            let total = 0;
            rows.forEach(([k, n]) => {
              total += n;
              countUp("burned-" + k, n, (v) => CL.fmt(Math.round(v), 0));
              const col = burnable.find((c) => c.key === k);
              const size = col && col.minTokenId != null && col.maxTokenId ? col.maxTokenId - col.minTokenId + 1 : 0;
              if (size) set("burned-" + k + "-pct", CL.fmt((n / size) * 100, 1) + "% of the collection, gone forever");
            });
            countUp("burned", total, (v) => CL.fmt(Math.round(v), 0));
          })
          .catch(() => set("burned", "—"))
      );
    }

    // Liquidity, fees and CLG price.
    if ((has("lp-tvl") || has("lp-earned") || has("clg-price") || has("lp-uncollected")) && CL.readLp) {
      jobs.push(
        CL.readLp()
          .then((d) => {
            countUp("lp-tvl", d.tvl, usd);
            countUp("lp-earned", d.earnedUsd, usd);
            countUp("lp-uncollected", d.uncollectedUsd, usd);
            set("clg-price", usd(d.prices.clg));
          })
          .catch(() => ["lp-tvl", "lp-earned", "lp-uncollected", "clg-price"].forEach((k) => set(k, "—")))
      );
    }

    // Burn reserves.
    if (has("reserve") || has("burn-status")) {
      const live = cfg.collections.filter((c) => c.redeemer);
      if (!live.length) {
        set("reserve", "Soon");
        set("reserve-sub", "burn contracts launching soon");
        set("burn-status", "Launching soon");
        document.querySelectorAll('[data-live="burn-status"]').forEach((el) => (el.className = "status status--soon"));
      } else {
        jobs.push(
          Promise.all(live.map((c) => CL.lite.redeemer(c.redeemer)))
            .then((rs) => {
              const reserve = rs.reduce((a, r) => a + CL.num(r.reserve), 0);
              const left = rs.reduce((a, r) => a + (r.burnsLeft ? Number(r.burnsLeft) : 0), 0);
              const paused = rs.every((r) => r.error);
              set("reserve", CL.fmt(reserve, 3) + " CLG");
              set("reserve-sub", paused ? "burns paused right now" : left + " burns covered now");
              set("burn-status", paused ? "Paused" : left > 0 ? "Open" : "Reserve empty");
              document.querySelectorAll('[data-live="burn-status"]').forEach((el) => (el.className = "status " + (paused || left < 1 ? "status--paused" : "status--live")));
            })
            .catch(() => set("reserve", "—"))
        );
      }
    }

    await Promise.allSettled(jobs);
    document.querySelectorAll("[data-live-updated]").forEach((el) => (el.textContent = "Live from Cronos · " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));
  }
})();
