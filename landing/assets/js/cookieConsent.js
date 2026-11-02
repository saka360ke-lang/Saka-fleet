/* Saka Fleet — cookie consent (v1.40.0). Vanilla JS, no third-party CMP.
   Truth: the site sets NO tracking or advertising cookies. Consent is stored
   in localStorage (versioned) so a future analytics switch must earn a fresh
   yes. Strictly necessary stays always-on. */
(function () {
  'use strict';

  var KEY = 'saka_cookie_consent';
  var VERSION = 1;

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
    write({ essential: true, preferences: false, analytics: false, mode: 'accept' });
    hideBanner();
  });
  $('cookieSettingsBtn').addEventListener('click', openSettings);
  $('cookieRejectBtn').addEventListener('click', function () {
    write({ essential: true, preferences: false, analytics: false, mode: 'reject' });
    closeSettings();
  });
  $('cookieSaveBtn').addEventListener('click', function () {
    write({
      essential: true,
      preferences: $('cookiePrefs').checked,
      analytics: $('cookieAnalytics').checked,
      mode: 'custom'
    });
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

  // Show the banner only when consent has never been recorded.
  if (!read()) setTimeout(showBanner, 800);
})();
