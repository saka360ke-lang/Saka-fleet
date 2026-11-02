/* Saka Fleet — landing page interactions. Vanilla JS, no dependencies. */
(function () {
  'use strict';

  var API_BASE = 'https://app.sakafleet.com';
  var RESEND_COOLDOWN_S = 60;

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function showStep(id) {
    var steps = document.querySelectorAll('.modal-step');
    for (var i = 0; i < steps.length; i += 1) steps[i].classList.remove('active');
    $(id).classList.add('active');
  }
  function setFieldError(id, on) {
    var el = $('f-' + id);
    if (!el) return;
    if (on) el.classList.add('error'); else el.classList.remove('error');
  }
  function isEmail(value) {
    return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value);
  }
  function cleanDigits(value) { return String(value || '').replace(/[^\d]/g, ''); }
  function detectLanguageName() {
    var lang = String(navigator.language || 'en').toLowerCase();
    var code = lang.split('-')[0];
    var map = { en: 'English', sw: 'Swahili', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian', nl: 'Dutch', pt: 'Portuguese', ar: 'Arabic', hi: 'Hindi' };
    return map[code] || 'English';
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /* ---------- modal ---------- */
  var modal = $('onboardModal');
  var openButtons = document.querySelectorAll('[data-open-onboard]');
  function openModal() { modal.classList.add('open'); document.body.style.overflow = 'hidden'; }
  function closeModal() { modal.classList.remove('open'); document.body.style.overflow = ''; }
  for (var i = 0; i < openButtons.length; i += 1) {
    openButtons[i].addEventListener('click', openModal);
  }
  $('onboardClose').addEventListener('click', closeModal);
  $('doneClose').addEventListener('click', closeModal);
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal.classList.contains('open')) closeModal(); });

  /* ---------- step 1: details ---------- */
  var form = $('onboardForm');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var firstName = $('firstName').value.trim();
    var lastName = $('lastName').value.trim();
    var email = $('email').value.trim().toLowerCase();
    var cc = $('countryCode').value;
    var digits = cleanDigits($('phone').value);
    var honeypot = $('website').value;

    var ok = true;
    setFieldError('firstName', !firstName); ok = ok && Boolean(firstName);
    setFieldError('lastName', !lastName); ok = ok && Boolean(lastName);
    setFieldError('email', !isEmail(email)); ok = ok && isEmail(email);
    var phoneValid = digits.length >= 9 && digits.length <= 15;
    setFieldError('phone', !phoneValid); ok = ok && phoneValid;
    if (honeypot) return; // bot — silently drop

    if (!ok) return;

    var fullPhone = cc + digits;
    window.__onboard = { firstName: firstName, lastName: lastName, email: email, phone: fullPhone };

    showStep('stepLegal');
  });

  /* ---------- step 2: legal gate ---------- */
  var consent = $('consent');
  var legalSubmit = $('legalSubmit');
  consent.addEventListener('change', function () { legalSubmit.disabled = !consent.checked; });
  $('legalBack').addEventListener('click', function () { showStep('stepDetails'); });

  function showDone(already) {
    if (already) {
      $('doneTitle').textContent = '🎉 You are all set!';
      $('doneSub').textContent = 'Your account is already verified — Saka is waiting for you on WhatsApp.';
      $('doneAlert').textContent = '✅ Account confirmed — no new signup needed.';
    }
    showStep('stepDone');
  }

  legalSubmit.addEventListener('click', function () {
    if (!consent.checked || !window.__onboard) return;
    legalSubmit.disabled = true;
    legalSubmit.textContent = 'Creating your account…';

    fetch(API_BASE + '/api/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        first_name: window.__onboard.firstName,
        last_name: window.__onboard.lastName,
        email: window.__onboard.email,
        phone: window.__onboard.phone,
        preferred_language: detectLanguageName(),
        consent: true
      })
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (out) {
        if (out.ok && out.body.success) {
          if (out.body.already_verified) {
            // v1.40.0 — the account already exists and is verified: skip the
            // OTP step and point straight to WhatsApp.
            showDone(true);
            return;
          }
          $('otpEmail').textContent = window.__onboard.email;
          window.__onboard.token = out.body.onboard_token || null;
          startResendCountdown();
          showStep('stepOtp');
        } else {
          legalSubmit.disabled = false;
          legalSubmit.textContent = 'Create My Account';
          alert('We could not reach Saka right now (' + ((out.body && out.body.error) || 'network error') + '). Please try again in a moment.');
        }
      })
      .catch(function () {
        legalSubmit.disabled = false;
        legalSubmit.textContent = 'Create My Account';
        alert('Network problem — please check your connection and try again.');
      });
  });
    var otpInputs = Array.prototype.slice.call($('otpRow').querySelectorAll('input'));
  otpInputs.forEach(function (input, idx) {
    input.addEventListener('input', function () {
      input.value = input.value.replace(/[^\d]/g, '').slice(-1);
      if (input.value && idx < otpInputs.length - 1) otpInputs[idx + 1].focus();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !input.value && idx > 0) otpInputs[idx - 1].focus();
    });
    input.addEventListener('paste', function (e) {
      var digits = cleanDigits((e.clipboardData || window.clipboardData).getData('text')).slice(0, 6);
      if (!digits) return;
      e.preventDefault();
      for (var d = 0; d < digits.length; d += 1) otpInputs[d].value = digits[d];
      if (digits.length === 6) $('otpVerify').focus();
    });
  });

  function readOtp() {
    return otpInputs.map(function (input) { return input.value; }).join('');
  }

  $('otpVerify').addEventListener('click', function () {
    var code = readOtp();
    if (code.length !== 6) { $('otpAlert').classList.add('show'); return; }
    $('otpAlert').classList.remove('show');
    $('otpVerify').disabled = true;

    fetch(API_BASE + '/api/onboard/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboard_token: window.__onboard.token, code: code })
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (out) {
        if (out.ok && out.body.success) {
          showDone(false);
        } else {
          $('otpVerify').disabled = false;
          $('otpAlert').classList.add('show');
          otpInputs.forEach(function (input) { input.value = ''; });
          otpInputs[0].focus();
        }
      })
      .catch(function () {
        $('otpVerify').disabled = false;
        alert('Network problem — please try again.');
      });
  });

  var resendTimer = null;
  function startResendCountdown() {
    var btn = $('otpResend');
    var label = $('resendTimer');
    var left = RESEND_COOLDOWN_S;
    btn.disabled = true;
    label.textContent = 'in ' + left + 's';
    if (resendTimer) clearInterval(resendTimer);
    resendTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(resendTimer);
        btn.disabled = false;
        label.textContent = '';
      } else {
        label.textContent = 'in ' + left + 's';
      }
    }, 1000);
  }

  $('otpResend').addEventListener('click', function () {
    fetch(API_BASE + '/api/onboard/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboard_token: window.__onboard.token })
    })
      .then(function () { startResendCountdown(); })
      .catch(function () { startResendCountdown(); });
  });

  /* ---------- changelog ---------- */
  fetch('/data/changelog.json')
    .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
    .then(function (data) {
      var list = $('changelogList');
      var html = '';
      (data.entries || []).forEach(function (entry) {
        html += '<div class="cl-entry">'
          + '<span class="ver">v' + escapeHtml(entry.version) + '</span>'
          + '<span class="date">' + escapeHtml(entry.date) + '</span>'
          + '<h3>' + escapeHtml(entry.title) + '</h3>'
          + '<p>' + escapeHtml(entry.summary) + '</p>'
          + '</div>';
      });
      list.innerHTML = html || '<div class="cl-entry"><div class="ver">No changelog yet.</div></div>';
    })
    .catch(function () {
      $('changelogList').innerHTML = '<div class="cl-entry"><p>Changelog is being prepared — check back soon.</p></div>';
    });

  /* ---------- live uptime probe ----------
     /api/health is the reliable alias: Google's edge can intercept /healthz
     on some Cloud Run deployments (documented v1.24.4), so we probe the
     alias first and fall back to /healthz for legacy revisions. */
  var dot = $('statusDot');
  var statusText = $('statusText');
  var statusDetail = $('statusDetail');
  var healthPaths = ['/api/health', '/healthz'];
  var checked = false;
  function markUp() {
    if (checked) return;
    checked = true;
    dot.classList.add('up');
    statusText.textContent = 'All systems operational';
    if (statusDetail) statusDetail.textContent = "Saka Fleet's servers responded in real time — uptime maintained at 99.9%.";
  }
  function markDown() {
    if (checked) return;
    checked = true;
    dot.classList.add('down');
    statusText.textContent = 'Status probe unavailable from your network';
    if (statusDetail) statusDetail.textContent = 'Could not reach the service — check your connection or try again shortly.';
  }
  function probeHealth(index) {
    if (checked || index >= healthPaths.length) return;
    fetch(API_BASE + healthPaths[index], { method: 'GET' })
      .then(function (res) {
        if (res.ok) {
          markUp();
        } else if (index === healthPaths.length - 1) {
          dot.classList.add('down');
          checked = true;
          statusText.textContent = 'Service is having a moment';
          statusDetail.textContent = 'The API responded with an unexpected status. Our supervisor is already on it.';
        } else {
          probeHealth(index + 1);
        }
      })
      .catch(function () {
        if (index === healthPaths.length - 1) markDown();
        else probeHealth(index + 1);
      });
  }
  /* ---------- local-currency pricing (v1.46.0) ---------- */
  (function localizePricing() {
    var code = document.documentElement.getAttribute('data-country');
    if (!code || code === 'GLOBAL') return;
    fetch('/data/countries.json')
      .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
      .then(function (data) {
        var entry = data.countries && data.countries[code];
        var currency = entry && entry.currency ? entry.currency : null;
        var rate = currency ? Number(data.exchangeRates && data.exchangeRates[currency]) : NaN;
        if (!currency || currency === 'USD' || !isFinite(rate) || rate <= 0) return;
        var locale = (entry && entry.locale) || 'en-US';
        function local(usd) {
          try {
            return new Intl.NumberFormat(locale, { style: 'currency', currency: currency, maximumFractionDigits: 0 }).format(Math.round(Number(usd) * rate));
          } catch (e) { return ''; }
        }
        var cards = document.querySelectorAll('.price-card');
        for (var i = 0; i < cards.length; i += 1) {
          var priceEl = cards[i].querySelector('.price');
          var perEl = cards[i].querySelector('.per');
          if (priceEl) {
            var monthly = priceEl.getAttribute('data-usd-monthly');
            if (monthly && Number(monthly) > 0) {
              var lm = local(monthly);
              if (lm) priceEl.innerHTML = lm + ' <span class="usd-hint">$' + monthly + '</span>';
            }
          }
          if (perEl) {
            var annual = perEl.getAttribute('data-usd-annual');
            if (annual && Number(annual) > 0) {
              var la = local(annual);
              if (la) perEl.innerHTML = 'per month &middot; ' + la + '/year <span class="usd-hint">$' + annual + '/year</span>';
            }
          }
        }
        var addon = document.getElementById('addonNote');
        if (addon) {
          var addonUsd = addon.getAttribute('data-addon-usd');
          if (addonUsd && Number(addonUsd) > 0) {
            var aa = local(addonUsd);
            if (aa) addon.innerHTML = 'Need more than 5 assets? Fleet Command grows with you &mdash; add assets for ' + aa + ' <span class="usd-hint">$' + addonUsd + '</span>/month each.';
          }
        }
        var note = document.getElementById('pricingNote');
        if (note) { note.textContent = 'Prices are set in USD; local figures are estimates.'; note.style.display = 'block'; }
      })
      .catch(function () { /* keep the USD defaults */ });
  })();
  probeHealth(0);
})();

