/* Cronos Legends — shared page behaviour: mobile menu, copy buttons, footer year, reveal-on-scroll,
 * card tilt, reading progress, toasts, and live numbers ([data-live]) when chain-lite.js is loaded.
 * Everything degrades to plain HTML without JavaScript. */
(function () {
  "use strict";
  document.documentElement.classList.add("js");
  const CL = (window.CL = window.CL || {});
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Hero card orbit (see orbit() below).
  const TURN = (2 * Math.PI) / 3; // the cards sit a third of a circle apart
  const ORBIT_KEY = "cl-orbit-paused";
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>';

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

    // -------------------------------------------------------------- hero card orbit
    document.querySelectorAll(".hero-art").forEach(orbit);

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

  // ---------------------------------------------------------------- hero card orbit
  // The three hero cards circle slowly and without pause, like a small carousel seen from a little
  // above: the front card is large and bright, the others smaller, dimmer and fanned out. The motion
  // eases each time a card reaches the front. Hovering slows it to a stop, clicking a card brings it
  // forward, and a small button pauses it. No motion for people who prefer reduced motion.
  // (Its constants live at the top of this file: ready() can run before this point.)

  // A card's look at orbit angle a (0 = front). Translate percentages are of the card's own size.
  function orbitPose(a) {
    const side = -Math.sin(a); // -1 left … 1 right
    const t = (Math.cos(a) + 1) / 2; // 0 back … 1 front
    const scale = 0.78 + 0.34 * t * t * t; // grows mostly on the last stretch to the front
    const x = side * 58; // 58% of a card = 30% of the stage
    const y = (t - 0.5) * 14; // cards at the back sit a little higher
    const tilt = side * 8 * (1 - t); // fanned out at the sides, upright at the front
    return {
      transform: "translate(-50%, -50%) translate(" + x.toFixed(2) + "%, " + y.toFixed(2) + "%) rotate(" + tilt.toFixed(2) + "deg) scale(" + scale.toFixed(4) + ")",
      filter: "brightness(" + (0.58 + 0.42 * t).toFixed(3) + ") saturate(" + (0.75 + 0.25 * t).toFixed(3) + ")",
      z: 1 + Math.round(t * 100),
      front: t > 0.97,
    };
  }

  function orbit(art) {
    const cards = Array.from(art.querySelectorAll(".card-art"));
    if (cards.length !== 3) return;
    art.classList.add("is-orbit");
    // The stage gets a button, so hide only the pictures from assistive technology.
    art.removeAttribute("aria-hidden");
    cards.forEach((c) => {
      c.classList.remove("bob");
      c.setAttribute("aria-hidden", "true");
    });

    const SPEED = TURN / 7; // radians per second; with the easing below a new card reaches the front about every 8 s
    let angle = -2 * TURN; // card i sits at angle + i * TURN, so the third card starts in front
    let pace = 0; // 0…1, eases towards 0 while paused or hovered
    let hovering = false;
    let paused = false;
    let glide = null; // { from, to, start } while a clicked card glides to the front
    let raf = 0;
    let last = 0;

    const place = () =>
      cards.forEach((el, i) => {
        const p = orbitPose(angle + i * TURN);
        el.style.transform = p.transform;
        el.style.filter = p.filter;
        el.style.zIndex = String(p.z);
        el.style.cursor = p.front ? "" : "pointer";
      });

    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (glide) {
        const k = Math.min(1, (now - glide.start) / 900);
        angle = glide.from + (glide.to - glide.from) * (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(2 - 2 * k, 3) / 2);
        if (k === 1) {
          glide = null;
          pace = 0;
        }
      } else {
        pace += ((paused || hovering ? 0 : 1) - pace) * Math.min(1, dt * 4);
        // Slower while a card is at the front (every third of a turn), quicker in between.
        angle = (angle + SPEED * pace * (1 - 0.45 * Math.cos(3 * angle)) * dt) % (2 * Math.PI);
      }
      place();
      raf = requestAnimationFrame(frame);
    };
    const run = () => {
      if (raf || reduceMotion) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const halt = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    cards.forEach((el, i) =>
      el.addEventListener("click", () => {
        // The shortest way round that puts this card at the front.
        const d = ((((-i * TURN - angle) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
        if (Math.abs(d) < 0.05) return;
        if (reduceMotion) {
          angle += d;
          place();
          return;
        }
        glide = { from: angle, to: angle + d, start: performance.now() };
        run();
      })
    );
    art.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse") hovering = true;
    });
    art.addEventListener("pointerleave", () => (hovering = false));

    if (!reduceMotion) {
      try {
        paused = localStorage.getItem(ORBIT_KEY) === "1";
      } catch (_) {}
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "orbit-toggle";
      const sync = () => {
        btn.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
        btn.setAttribute("aria-label", paused ? "Play the card animation" : "Pause the card animation");
      };
      btn.addEventListener("click", () => {
        paused = !paused;
        try {
          localStorage.setItem(ORBIT_KEY, paused ? "1" : "0");
        } catch (_) {}
        sync();
      });
      sync();
      art.appendChild(btn);
    }

    place();
    // Only animate while the stage is on screen; browsers already stop animation frames in background tabs.
    if ("IntersectionObserver" in window) new IntersectionObserver(([en]) => (en.isIntersecting ? run() : halt())).observe(art);
    else run();
  }
  CL.orbitPose = orbitPose;

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
