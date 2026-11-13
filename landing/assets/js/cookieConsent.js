/* Saka Fleet — cookie consent (v1.49.0; scope bumped v1.96.6; first-party GTM
   delivery v1.96.9). Vanilla JS, no third-party CMP. Google Tag Manager (and
   the tags you configure inside it, e.g. Meta Pixel and Google Ads) load ONLY
   after an explicit analytics opt-in — now from the first-party proxy
   https://gtm.sakafleet.com (same container, no blocker-host lookup; a dead
   proxy is swallowed below and can never block the page). Consent is stored in
   localStorage (versioned) so a policy change must earn a fresh yes — v3 covers
   signup Enhanced Conversions (hashed email/phone for ad measurement).
   Strictly necessary stays always-on. */
(function () {
  'use strict';

  var KEY = 'saka_cookie_consent';
  var VERSION = 3;
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
        j.src = 'https://gtm.sakafleet.com/gtm.js?id=' + i + dl;
        f.parentNode.insertBefore(j, f);
      })(window, document, 'script', 'dataLayer', GTM_ID);
      // v1.96.6 — the container only exists after an explicit opt-in, so the
      // consent state is unambiguous: tell GTM (Consent Mode) that analytics
      // and ad measurement are granted. Signup Enhanced Conversions keys off it.
      window.dataLayer.push({ event: 'consent_analytics_granted', analytics: true });
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

  // v1.96.8 — the banner rides above every overlay (CSS z-index 9999) and the
  // `attention` pulse draws the eye to the bottom of the screen when the signup
  // gate re-opens it. Any choice (accept / settings / save) ends the pulse.
  function showBanner() { banner.classList.add('show'); banner.classList.add('attention'); }
  function hideBanner() { banner.classList.remove('show'); banner.classList.remove('attention'); }
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
