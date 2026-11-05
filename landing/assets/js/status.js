/* Saka Fleet — live status page (v1.40.0). Vanilla JS.
   Probes /api/health (alias /healthz), refreshes every 30 seconds, and when
   the service is unreachable shows a plain-language incident ticker with a
   live downtime counter. No jargon, no technical details. */
(function () {
  'use strict';

  var API_BASE = 'https://app.sakafleet.com';
  var HEALTH_PATHS = ['/api/health', '/healthz'];
  var REFRESH_MS = 30000;

  var dot = document.getElementById('statusDot');
  var word = document.getElementById('statusWord');
  var meta = document.getElementById('statusMeta');
  var ticker = document.getElementById('incidentTicker');
  var line = document.getElementById('incidentLine');
  var tickerMeta = document.getElementById('incidentMeta');

  var downSince = null;
  var tickerTimer = null;
  var lineIndex = 0;

  var TICKER_LINES = [
    'Our team was alerted the moment this started, and we are already on it.',
    'Everything you have logged is safe — nothing is lost.',
    'You can keep messaging Saka; anything we miss now can simply be sent again.',
    'This page checks in by itself every 30 seconds until we are back.'
  ];

  function timeAgo(ms) {
    var s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ago';
  }

  function fmtDuration(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60);
    var h = Math.floor(m / 60);
    if (h > 0) return h + 'h ' + (m % 60) + 'm';
    if (m > 0) return m + 'm ' + (s % 60) + 's';
    return s + 's';
  }

  function showUp() {
    if (downSince) {
      downSince = null;
      clearInterval(tickerTimer);
      ticker.classList.remove('show');
    }
    dot.className = 'status-dot up';
    word.textContent = 'All systems operational';
    meta.textContent = 'Checked ' + timeAgo(Date.now()) + ' — this page refreshes itself every 30 seconds.';
  }

  function showDown() {
    dot.className = 'status-dot down';
    word.textContent = "We're having a moment";
    if (!downSince) {
      downSince = Date.now();
      lineIndex = 0;
      line.textContent = TICKER_LINES[0];
      ticker.classList.add('show');
      clearInterval(tickerTimer);
      tickerTimer = setInterval(function () {
        lineIndex = (lineIndex + 1) % TICKER_LINES.length;
        line.textContent = TICKER_LINES[lineIndex];
      }, 4000);
    }
    meta.textContent = 'This has been going on for ' + fmtDuration(Date.now() - downSince) + '. Checking again shortly…';
    tickerMeta.textContent = 'Last healthy check: ' + timeAgo(downSince) + '. Everything you logged remains safe.';
  }

  function probe(index) {
    if (index >= HEALTH_PATHS.length) { showDown(); return; }
    fetch(API_BASE + HEALTH_PATHS[index], { method: 'GET' })
      .then(function (res) {
        if (res.ok) showUp();
        else probe(index + 1);
      })
      .catch(function () { probe(index + 1); });
  }

  probe(0);
  setInterval(function () { probe(0); }, REFRESH_MS);

  /* ---------- changelog (preview-first, v1.59.0) ---------- */
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  // The feed is a preview, not an essay: one short title and ONE minimal line
  // stay visible; the full note expands on demand.
  function firstSentence(text) {
    var value = String(text || '').trim();
    if (!value) return '';
    var match = value.match(/^[^.!?]+[.!?]/);
    return match ? match[0].trim() : value;
  }
  function previewOf(entry) {
    var text = String((entry && entry.preview) || firstSentence(entry && entry.summary) || '').trim();
    if (text.length <= 96) return text;
    return text.slice(0, 93).replace(/[\s,;:.-]+$/, '') + '…';
  }
  function renderChangelogEntry(entry) {
    var preview = previewOf(entry);
    var detail = String((entry && entry.summary) || '').trim();
    var hasDetail = Boolean(detail) && detail !== preview;
    return '<details class="cl-entry">'
      + '<summary>'
      + '<span class="ver">v' + escapeHtml(entry.version) + '</span>'
      + '<span class="date">' + escapeHtml(entry.date) + '</span>'
      + '<h3>' + escapeHtml(entry.title) + '</h3>'
      + '<p class="cl-preview">' + escapeHtml(preview) + '</p>'
      + (hasDetail ? '<span class="cl-more">Read more</span>' : '')
      + '</summary>'
      + (hasDetail ? '<p class="cl-detail">' + escapeHtml(detail) + '</p>' : '')
      + '</details>';
  }
  fetch('/data/changelog.json')
    .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
    .then(function (data) {
      var list = document.getElementById('changelogList');
      var html = '';
      (data.entries || []).forEach(function (entry) {
        html += renderChangelogEntry(entry);
      });
      list.innerHTML = html || '<div class="cl-entry"><div class="ver">No changelog yet.</div></div>';
    })
    .catch(function () {
      document.getElementById('changelogList').innerHTML = '<div class="cl-entry"><p>Changelog is being prepared — check back soon.</p></div>';
    });
})();
