/**
 * OpenCall "Call me" button.
 *
 *   <script src="https://<pwa-origin>/embed.js" data-user="name" data-label="Call me"></script>
 *
 * Injects a floating button; clicking it opens /u/<name>?embed=1 in a modal
 * iframe (allow="microphone"). Optional: data-position="left" (default right).
 * Rendered inside a shadow root so the host page's CSS cannot touch it.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) return;
  var user = String(script.getAttribute('data-user') || '').replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(user)) { console.warn('[OpenCall] embed.js: invalid data-user'); return; }
  var label = (script.getAttribute('data-label') || 'Call me').slice(0, 30);
  var left = script.getAttribute('data-position') === 'left';
  var origin = new URL(script.src, location.href).origin;
  var src = origin + '/u/' + encodeURIComponent(user) + '?embed=1';

  var host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.fab{position:fixed;bottom:20px;' + (left ? 'left' : 'right') + ':20px;display:flex;align-items:center;gap:8px;' +
    'padding:13px 20px;border:0;border-radius:999px;background:#c8f55a;color:#0a1a05;font-size:16px;font-weight:700;' +
    'cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35)}' +
    '.fab:focus-visible,.x:focus-visible{outline:3px solid #63b4ff;outline-offset:2px}' +
    '.ov{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;padding:12px}' +
    '.ov.open{display:flex}' +
    '.box{position:relative;width:min(420px,100%);height:min(640px,100%);border-radius:18px;overflow:hidden;background:#060a10;' +
    'box-shadow:0 20px 60px rgba(0,0,0,.5)}' +
    '.x{position:absolute;top:8px;right:8px;width:36px;height:36px;border:0;border-radius:50%;background:rgba(255,255,255,.14);' +
    'color:#fff;font-size:20px;line-height:1;cursor:pointer;z-index:1}' +
    'iframe{width:100%;height:100%;border:0;display:block}' +
    '@media (prefers-reduced-motion:no-preference){.ov.open .box{animation:in .18s ease-out}@keyframes in{from{transform:translateY(12px);opacity:0}}}' +
    '</style>' +
    '<button class="fab" type="button" aria-haspopup="dialog"></button>' +
    '<div class="ov"><div class="box" role="dialog" aria-modal="true" aria-label="">' +
    '<button class="x" type="button" aria-label="Close call window">&times;</button></div></div>';

  var fab = root.querySelector('.fab');
  fab.textContent = '☎ ' + label;
  var ov = root.querySelector('.ov');
  var box = root.querySelector('.box');
  var close = root.querySelector('.x');
  box.setAttribute('aria-label', 'Call @' + user);
  var frame = null, opener = null;

  function open() {
    opener = fab;
    if (!frame) {
      frame = document.createElement('iframe');
      frame.title = 'Call @' + user;
      frame.allow = 'microphone';
      frame.src = src;
      box.appendChild(frame);
    }
    ov.classList.add('open');
    close.focus();
  }
  function shut() {
    ov.classList.remove('open');
    if (frame) { frame.remove(); frame = null; }      // dropping the iframe also ends any call
    if (opener) opener.focus();
  }

  fab.addEventListener('click', open);
  close.addEventListener('click', shut);
  ov.addEventListener('click', function (e) { if (e.target === ov) shut(); });
  root.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { shut(); return; }
    if (e.key === 'Tab' && ov.classList.contains('open')) {      // keep focus inside the dialog
      e.preventDefault();
      (root.activeElement === close && frame) ? frame.focus() : close.focus();
    }
  });

  (document.body || document.documentElement).appendChild(host);
})();
