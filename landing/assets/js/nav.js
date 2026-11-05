/* Saka Fleet — ember drawer menu (v1.59.3).
   Adds a burger on tablet/mobile (<= 960px) and builds a full-screen overlay
   menu from the existing `.nav-links`, so every page with a header gets the
   same menu without duplicating markup. Vanilla, dependency-free, and inert on
   pages without a `.nav-links` list (e.g. /status). */
(function () {
  'use strict';

  var header = document.querySelector('header.nav');
  if (!header) return;
  var links = header.querySelector('.nav-links');
  if (!links) return;
  var anchorItems = links.querySelectorAll('a');
  if (!anchorItems.length) return;

  var ctaWrap = header.querySelector('.nav-cta');
  var burger = document.createElement('button');
  burger.className = 'nav-burger';
  burger.id = 'navBurger';
  burger.type = 'button';
  burger.setAttribute('aria-label', 'Open menu');
  burger.setAttribute('aria-expanded', 'false');
  burger.setAttribute('aria-controls', 'navMenu');
  burger.innerHTML = '<span></span><span></span><span></span>';
  (ctaWrap || header.querySelector('.nav-inner') || header).appendChild(burger);

  var menu = document.createElement('div');
  menu.className = 'nav-menu';
  menu.id = 'navMenu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-modal', 'true');
  menu.setAttribute('aria-label', 'Menu');

  var inner = document.createElement('nav');
  inner.className = 'nav-menu-inner';
  inner.setAttribute('aria-label', 'Menu links');
  var index = 0;
  for (var i = 0; i < anchorItems.length; i += 1) {
    var source = anchorItems[i];
    var link = document.createElement('a');
    link.href = source.getAttribute('href') || '/';
    link.textContent = source.textContent;
    link.style.setProperty('--i', String(index));
    inner.appendChild(link);
    index += 1;
  }
  var cta = document.createElement('a');
  cta.className = 'btn btn-primary nav-menu-cta';
  cta.href = '/#pricing';
  cta.textContent = 'Get Started Free';
  cta.style.setProperty('--i', String(index));
  inner.appendChild(cta);
  menu.appendChild(inner);
  document.body.appendChild(menu);

  function isOpen() { return document.body.classList.contains('nav-open'); }

  function setOpen(open) {
    document.body.classList.toggle('nav-open', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    if (open) {
      var first = inner.querySelector('a');
      if (first && first.focus) first.focus({ preventScroll: true });
    }
  }

  burger.addEventListener('click', function () { setOpen(!isOpen()); });
  menu.addEventListener('click', function (event) {
    if (event.target === menu) setOpen(false);
  });
  Array.prototype.forEach.call(inner.querySelectorAll('a'), function (link) {
    link.addEventListener('click', function () { setOpen(false); });
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isOpen()) {
      setOpen(false);
      burger.focus();
    }
  });
  window.addEventListener('resize', function () {
    if (window.innerWidth > 960 && isOpen()) setOpen(false);
  });

  // v1.59.7 — smooth scrolling ONLY for nav anchor clicks. The old CSS-wide
  // `scroll-behavior: smooth` made holding a scroll button feel sticky; this
  // keeps anchor jumps smooth while normal scrolling stays native.
  document.addEventListener('click', function (event) {
    var anchor = event.target && event.target.closest ? event.target.closest('a[href^="#"]') : null;
    if (!anchor) return;
    var hash = anchor.getAttribute('href') || '';
    if (hash.length < 2) return;
    var section = document.getElementById(hash.slice(1));
    if (!section) return;
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    event.preventDefault();
    if (isOpen()) setOpen(false);
    section.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  });
})();
