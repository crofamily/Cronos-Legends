/* Site-wide rolling notice banner.
 * Self-injecting: include once per page with
 *   <script src="/scripts/notice-banner.js" defer></script>
 * Edit NOTICE_TEXT below to change the message everywhere at once. */
(function () {
  var NOTICE_TEXT =
    'Website to be updated in Q3/2026 — at the moment not fully functioning';

  function init() {
    if (document.getElementById('cl-notice-banner')) return;

    var style = document.createElement('style');
    style.textContent =
      '#cl-notice-banner{position:fixed;left:0;right:0;bottom:0;z-index:99999;' +
      'background:linear-gradient(90deg,#7a1f1f,#b8860b);color:#fff;' +
      "font-family:'Inter',sans-serif;font-size:14px;font-weight:600;" +
      'line-height:36px;height:36px;overflow:hidden;white-space:nowrap;' +
      'box-shadow:0 -2px 12px rgba(0,0,0,.5)}' +
      '#cl-notice-banner .cl-notice-track{display:inline-block;padding-left:100%;' +
      'animation:cl-notice-scroll 22s linear infinite}' +
      '#cl-notice-banner:hover .cl-notice-track{animation-play-state:paused}' +
      '#cl-notice-banner .cl-notice-track span{padding:0 4rem}' +
      '@keyframes cl-notice-scroll{0%{transform:translateX(0)}' +
      '100%{transform:translateX(-100%)}}' +
      '@media (prefers-reduced-motion:reduce){' +
      '#cl-notice-banner .cl-notice-track{animation:none;padding-left:0;' +
      'text-align:center;display:block}}';
    document.head.appendChild(style);

    var bar = document.createElement('div');
    bar.id = 'cl-notice-banner';
    bar.setAttribute('role', 'status');

    var track = document.createElement('div');
    track.className = 'cl-notice-track';
    // Repeat so the scrolling line stays populated across the viewport.
    track.innerHTML =
      '<span>' + NOTICE_TEXT + '</span><span>' + NOTICE_TEXT +
      '</span><span>' + NOTICE_TEXT + '</span>';

    bar.appendChild(track);
    document.body.appendChild(bar);
    document.body.style.paddingBottom = '36px';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
