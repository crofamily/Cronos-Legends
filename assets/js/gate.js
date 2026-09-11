/* Cronos Legends — temporary password screen while the website is being updated.
 *
 * A courtesy gate, not security: GitHub Pages is static, so the pages can still be downloaded
 * directly. Visitors who enter the password once stay unlocked in that browser.
 *
 * To switch the screen off everywhere, set ENABLED to false (or remove the gate.js <script> tags).
 */
(function () {
  "use strict";
  var ENABLED = true;
  var PASSWORD = "crovia"; // compared case-insensitively
  var KEY = "cl-preview-unlocked";

  if (!ENABLED) return;
  try {
    if (localStorage.getItem(KEY) === "1") return;
  } catch (e) {
    /* storage blocked: ask every time */
  }

  var root = document.documentElement;
  root.classList.add("cl-gated");

  var css =
    "html.cl-gated body>*:not(#cl-gate){display:none!important}" +
    "html.cl-gated,html.cl-gated body{overflow:hidden;background:#0e0f16}" +
    "#cl-gate{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;overflow:auto;" +
    "background:radial-gradient(55% 45% at 50% 0%,rgba(242,185,59,.16),transparent 70%),radial-gradient(40% 40% at 15% 100%,rgba(94,214,160,.1),transparent 70%),radial-gradient(40% 40% at 85% 100%,rgba(255,106,82,.1),transparent 70%),#0e0f16;" +
    "color:#f4efe6;font:16px/1.6 Figtree,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
    "#cl-gate .box{width:min(440px,100%);text-align:center}" +
    "#cl-gate img{width:88px;height:88px;margin:0 auto 18px;display:block}" +
    "#cl-gate .eyebrow{font:700 12px/1.2 Figtree,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#f2b93b;margin:0 0 10px}" +
    "#cl-gate h1{font:700 clamp(28px,6vw,38px)/1.1 Cinzel,Georgia,serif;margin:0 0 12px;color:#f4efe6}" +
    "#cl-gate p{margin:0 0 22px;color:#c6c1d2}" +
    "#cl-gate form{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}" +
    "#cl-gate label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}" +
    "#cl-gate input{flex:1 1 200px;min-height:48px;padding:0 16px;border-radius:14px;border:1px solid #3a3f5c;background:#151724;color:#f4efe6;font:16px Figtree,system-ui,sans-serif}" +
    "#cl-gate input:focus{outline:3px solid #ffd36e;outline-offset:2px}" +
    "#cl-gate button{min-height:48px;padding:0 22px;border:0;border-radius:14px;background:linear-gradient(180deg,#ffcf5f,#eaa928);color:#1f1503;font:700 16px Figtree,system-ui,sans-serif;cursor:pointer}" +
    "#cl-gate button:focus-visible{outline:3px solid #ffd36e;outline-offset:2px}" +
    "#cl-gate .err{min-height:24px;margin:12px 0 0;color:#ffb3a6;font-size:14px}" +
    "#cl-gate .links{margin-top:26px;font-size:14px;color:#938fa8}" +
    "#cl-gate .links a{color:#f2b93b;text-decoration:none;margin:0 6px}" +
    "#cl-gate .shake{animation:cl-shake .35s}" +
    "@keyframes cl-shake{25%{transform:translateX(-6px)}50%{transform:translateX(6px)}75%{transform:translateX(-3px)}}" +
    "@media (prefers-reduced-motion:reduce){#cl-gate .shake{animation:none}}";
  var style = document.createElement("style");
  style.textContent = css;
  (document.head || root).appendChild(style);

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text) n.textContent = text;
    return n;
  }

  function mount() {
    if (document.getElementById("cl-gate")) return;
    var gate = el("div", { id: "cl-gate", role: "dialog", "aria-modal": "true", "aria-labelledby": "cl-gate-title" });
    var box = el("div", { class: "box" });
    box.appendChild(el("img", { src: "/assets/img/clg-256.webp", alt: "", width: "88", height: "88" }));
    box.appendChild(el("p", { class: "eyebrow" }, "Cronos Legends"));
    box.appendChild(el("h1", { id: "cl-gate-title" }, "We're updating the website"));
    box.appendChild(el("p", {}, "A brand-new Cronos Legends site is almost ready. Enter the password to take a look."));

    var form = el("form", { autocomplete: "off" });
    var label = el("label", { for: "cl-gate-input" }, "Password");
    var input = el("input", { id: "cl-gate-input", type: "password", placeholder: "Password", autocomplete: "off", autocapitalize: "off", spellcheck: "false", required: "" });
    var button = el("button", { type: "submit" }, "Enter");
    form.appendChild(label);
    form.appendChild(input);
    form.appendChild(button);
    box.appendChild(form);
    var err = el("p", { class: "err", role: "alert", "aria-live": "polite" });
    box.appendChild(err);

    var links = el("div", { class: "links" });
    links.appendChild(document.createTextNode("Follow along: "));
    links.appendChild(el("a", { href: "https://discord.gg/huWn4Tz4g4", rel: "noopener", target: "_blank" }, "Discord"));
    links.appendChild(el("a", { href: "https://x.com/CronosLegends", rel: "noopener", target: "_blank" }, "X"));
    box.appendChild(links);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (input.value.trim().toLowerCase() === PASSWORD) {
        try {
          localStorage.setItem(KEY, "1");
        } catch (x) {
          /* unlocked for this page only */
        }
        root.classList.remove("cl-gated");
        gate.remove();
        style.remove();
      } else {
        err.textContent = "That's not the password. Try again.";
        form.classList.remove("shake");
        void form.offsetWidth;
        form.classList.add("shake");
        input.select();
      }
    });

    gate.appendChild(box);
    document.body.appendChild(gate);
    input.focus();
  }

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
