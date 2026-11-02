/* Saka Fleet — locale personalization (v1.41.0). Vanilla JS.
   Detects the visitor's country from the browser locale (no IP lookup, no
   third party), then personalizes three things from data/countries.json —
   which mirrors Saka's live compliance catalog (drift-guarded by
   test_landing_static):
     1. the signup form's default calling code,
     2. a small flag chip ("Serving vehicle owners in <country>"),
     3. the compliance section — the real documents Saka tracks there,
        named in the country's own words.
   Unknown countries get the neutral GLOBAL copy and no flag. */
(function () {
  'use strict';

  function flagOf(code) {
    if (!code || code === 'GLOBAL') return '';
    try {
      return String.fromCodePoint(...[...code].map((ch) => 127397 + ch.charCodeAt(0)));
    } catch (e) {
      return '';
    }
  }

  function detectRegion() {
    try {
      var lang = String(navigator.language || 'en').toUpperCase();
      var region = lang.split('-')[1];
      return /^[A-Z]{2}$/.test(region || '') ? region : null;
    } catch (e) {
      return null;
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function renderCompliance(profile, globalProfile, universal) {
    var title = document.getElementById('localeComplianceTitle');
    var sub = document.getElementById('localeComplianceSub');
    var cards = document.getElementById('localeComplianceCards');
    var lingo = document.getElementById('localeComplianceLingo');
    if (!title || !sub || !cards) return;

    var source = profile || globalProfile;
    title.textContent = profile
      ? 'In ' + profile.name + ', Saka keeps these in check'
      : source.title;
    sub.textContent = profile
      ? 'Real documents, called by their real names here — Saka reminds you before they lapse and checks them before a driver takes over.'
      : source.subtitle;

    var items = [];
    if (profile && profile.compliance.minimal) {
      items.push({ label: profile.compliance.minimal, note: 'The essential document every driver here must hold — Saka checks it before a driver takes over your vehicle.' });
    }
    (profile ? (profile.compliance.additional || []) : []).forEach(function (label) {
      items.push({ label: label, note: 'Saka tracks the expiry and nudges you to renew in time, so it never catches you out.' });
    });
    (profile ? (universal || []) : []).forEach(function (row) { items.push({ label: row.label, note: row.note }); });
    if (!profile) {
      (source.compliance || []).forEach(function (row) { items.push({ label: row.label, note: row.note }); });
    }

    var html = '';
    items.forEach(function (row) {
      html += '<div class="card">'
        + '<div class="icon">🛡️</div>'
        + '<h3>' + escapeHtml(row.label) + '</h3>'
        + '<p>' + escapeHtml(row.note) + '</p>'
        + '</div>';
    });
    cards.innerHTML = html;

    if (lingo) {
      if (profile && profile.lingo && profile.lingo.length) {
        var terms = [profile.plateExample].concat(profile.lingo).filter(Boolean);
        lingo.textContent = 'Talk to Saka in your words: ' + terms.map(function (t) { return '"' + t + '"'; }).join(', ') + ' — one line and it\'s logged.';
      } else {
        lingo.textContent = 'Talk to Saka in plain words — no forms, no jargon, wherever you are.';
      }
    }
  }

  function apply(db) {
    var boot = window.__SAKA_BOOT__;
    var code = (boot && boot.code) ? boot.code : detectRegion();
    var profile = code ? db.countries[code] : null;

    // The bootstrap already rendered the flag chip and phone code on first
    // paint (timezone-first + optional override). Keep the phone code in sync.
    var select = document.getElementById('countryCode');
    if (select && profile && profile.calling) select.value = profile.calling;

    renderCompliance(profile, db.global, db.universal);
  }

  fetch('/data/countries.json')
    .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
    .then(apply)
    .catch(function () { /* static fallback content already covers GLOBAL */ });
})();
