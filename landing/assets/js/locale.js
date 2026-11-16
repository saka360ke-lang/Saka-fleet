/* Saka Fleet — locale personalization (v1.41.0; localized examples v1.98.2).
   Vanilla JS. Detects the visitor's country from the browser locale (no IP
   lookup, no third party), then personalizes FOUR things from
   data/countries.json — which mirrors Saka's live compliance catalog
   (drift-guarded by test_landing_static):
     1. the signup form's default calling code,
     2. a small flag chip ("Based on your location…"),
     3. the compliance section — the real documents Saka tracks there,
     4. the localized examples (v1.98.2): the phone-mock conversation, the two
        "How it works" chips and the footer locale badge. Metric countries see
        litres/km, imperial countries see gallons/miles, and money is
        formatted in the country's currency from the SAME exchangeRates table
        main.js uses for pricing (estimates, never a second rate source).
   Unknown countries get the neutral GLOBAL copy (metric + USD) and no flag.
   Writes go to ID slots only — never to data-* attributes. */

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

  /* v1.98.2 — localized proof: the phone-mock conversation and the two
     "How it works" chips. Two unit templates (metric / imperial) cover the
     whole planet; money is formatted in the visitor's currency from the same
     exchangeRates table main.js uses for pricing, so the page never
     contradicts itself. Unknown countries keep the static GLOBAL defaults. */
  var MOCK_USD = 53;
  var UNIT_EXAMPLES = {
    metric: {
      fuelLine: 'Logged 40L diesel at 50,350 km — full tank, Shell 😊',
      detail: function (money) { return '40 L · full tank · 50,350 km · ' + money; },
      odo: '50,350 km',
      economy: '14.2 km/L — Excellent 🟢',
      reminder: 'Remind oil change at 55,000 km',
      howSay: '“Logged 40L diesel at 50,350 km — full tank”',
      howSaved: function (money) { return '⛽ 40 L · 50,350 km · ' + money + ' — oil-change reminder set'; }
    },
    imperial: {
      fuelLine: 'Logged 10 gal at 30,000 mi — full tank, Shell 😊',
      detail: function (money) { return '10 gal · full tank · 30,000 mi · ' + money; },
      odo: '30,000 mi',
      economy: '23.5 mpg — Excellent 🟢',
      reminder: 'Remind oil change at 34,000 mi',
      howSay: '“Logged 10 gal at 30,000 mi — full tank”',
      howSaved: function (money) { return '⛽ 10 gal · 30,000 mi · ' + money + ' — oil-change reminder set'; }
    }
  };

  function moneyText(profile, db) {
    if (!profile) return 'about $' + MOCK_USD;
    var currency = profile.currency;
    var rate = Number(db && db.exchangeRates && db.exchangeRates[currency]);
    if (!currency || currency === 'USD' || !isFinite(rate) || rate <= 0) return 'about $' + MOCK_USD;
    try {
      var local = new Intl.NumberFormat(profile.locale || 'en-US', {
        style: 'currency', currency: currency, maximumFractionDigits: 0
      }).format(Math.round(MOCK_USD * rate));
      return 'about ' + local;
    } catch (e) {
      return 'about $' + MOCK_USD;
    }
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el && value) el.textContent = value;
  }

  function renderLocalExamples(profile, db) {
    // GLOBAL visitors keep the static HTML defaults (metric + USD).
    if (!profile) return;
    var units = profile.units === 'imperial' ? UNIT_EXAMPLES.imperial : UNIT_EXAMPLES.metric;
    var money = moneyText(profile, db);
    setText('mockMe1', units.fuelLine);
    setText('mockDetail1', units.detail(money));
    setText('mockOdo', units.odo);
    setText('mockEconomy', units.economy);
    setText('mockMe2', units.reminder);
    setText('howExample2', units.howSay);
    setText('howExample3', units.howSaved(money));
    setText('mockNote', 'Examples shown for ' + profile.name + ' — local prices are estimates.');
    var badge = document.getElementById('footerLocaleBadge');
    if (badge) {
      badge.textContent = flagOf(profile.code) + ' ' + profile.name + ' · prices in ' + profile.currency + ' (estimates)';
      badge.hidden = false;
    }
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
    renderLocalExamples(profile, db);
  }

  fetch('/data/countries.json')
    .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
    .then(apply)
    .catch(function () { /* static fallback content already covers GLOBAL */ });
})();
