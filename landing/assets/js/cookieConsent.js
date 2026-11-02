/* Saka Fleet — cookie consent (v1.49.0). Vanilla JS, no third-party CMP.
   Google Tag Manager (and the tags you configure inside it, e.g. Meta Pixel)
   load ONLY after an explicit analytics opt-in. Consent is stored in
   localStorage (versioned) so a policy change must earn a fresh yes. Strictly
   necessary stays always-on. */
(function () {
  'use strict';

  var KEY = 'saka_cookie_consent';
  var VERSION = 2;
  var GTM_ID = 'GTM-TGR68X2X';

  function $(id) { return document.getElementById(id); }
  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      return data && data.v === VERSION ? data : null;
    } catch (e) { return null; }
  }
  function write(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.assign({ v: VERSION, at: new Date().toISOString() }, data)));
    } catch (e) { /* private mode: banner simply reappears next visit */ }
  }

  // Load Google Tag Manager exactly once, only after analytics consent.
  var gtmLoaded = false;
  function loadGtm() {
    if (gtmLoaded) return;
    gtmLoaded = true;
    try {
      (function (w, d, s, l, i) {
        w[l] = w[l] || [];
        w[l].push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
        var f = d.getElementsByTagName(s)[0];
        var j = d.createElement(s);
        var dl = l !== 'dataLayer' ? '&l=' + l : '';
        j.async = true;
        j.src = 'https://www.googletagmanager.com/gtm.js?id=' + i + dl;
        f.parentNode.insertBefore(j, f);
      })(window, document, 'script', 'dataLayer', GTM_ID);
    } catch (e) { /* analytics is best-effort and never blocks the page */ }
  }
  function applyConsent(data) {
    if (data && data.analytics === true) loadGtm();
  }

  // v1.49.3 — expose consent state so the signup flow can gate on a recorded choice.
  window.__sakaCookies = {
    chosen: function () { return read() !== null; },
    open: function () { showBanner(); }
  };

  var banner = $('cookieBanner');
  var backdrop = $('cookieSettingsBackdrop');
  if (!banner || !backdrop) return;

  function showBanner() { banner.classList.add('show'); }
  function hideBanner() { banner.classList.remove('show'); }
  function openSettings() {
    var saved = read();
    $('cookiePrefs').checked = Boolean(saved && saved.preferences);
    $('cookieAnalytics').checked = Boolean(saved && saved.analytics);
    backdrop.classList.add('open');
    hideBanner();
  }
  function closeSettings() { backdrop.classList.remove('open'); }

  $('cookieAcceptBtn').addEventListener('click', function () {
    write({ essential: true, preferences: false, analytics: true, mode: 'accept' });
    applyConsent({ analytics: true });
    hideBanner();
  });
  $('cookieSettingsBtn').addEventListener('click', openSettings);
  $('cookieRejectBtn').addEventListener('click', function () {
    write({ essential: true, preferences: false, analytics: false, mode: 'reject' });
    closeSettings();
  });
  $('cookieSaveBtn').addEventListener('click', function () {
    var data = {
      essential: true,
      preferences: $('cookiePrefs').checked,
      analytics: $('cookieAnalytics').checked,
      mode: 'custom'
    };
    write(data);
    applyConsent(data);
    closeSettings();
  });
  backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeSettings(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && backdrop.classList.contains('open')) closeSettings();
  });

  // Footer "Cookie settings" links re-open the panel any time.
  var reopen = document.querySelectorAll('[data-cookie-settings]');
  for (var i = 0; i < reopen.length; i += 1) {
    reopen[i].addEventListener('click', function (e) { e.preventDefault(); openSettings(); });
  }

  // Resume analytics on a returning visit with stored consent; otherwise show the banner.
  var savedConsent = read();
  if (savedConsent) {
    applyConsent(savedConsent);
  } else {
    setTimeout(showBanner, 800);
  }
})();
