/* Jake Biddlecome — site interactions */
(function () {
  'use strict';

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── Mobile nav ─────────────────────────────────────────── */
  var navToggle = document.getElementById('nav-toggle');
  var navLinks = document.getElementById('nav-links');
  if (navToggle && navLinks) {
    navToggle.addEventListener('click', function () {
      var open = navLinks.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    navLinks.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        navLinks.classList.remove('open');
        navToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ── Scroll reveals ─────────────────────────────────────── */
  var revealables = document.querySelectorAll('.reveal, .reveal-stagger');
  if (reducedMotion) {
    revealables.forEach(function (el) { el.classList.add('in'); });
  } else {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealables.forEach(function (el) { revealObserver.observe(el); });
  }

  /* ── Stat count-up ──────────────────────────────────────── */
  function countUp(el) {
    var target = parseInt(el.getAttribute('data-count'), 10) || 0;
    if (reducedMotion) { el.textContent = target; return; }
    var duration = 1200;
    var start = null;
    function step(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / duration, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  var counters = document.querySelectorAll('[data-count]');
  if (counters.length) {
    var countObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          countUp(entry.target);
          countObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.4 });
    counters.forEach(function (el) { countObserver.observe(el); });
  }

  /* ── Architecture visualizer ────────────────────────────── */
  var ARCH_DETAILS = {
    mobile: {
      name: 'mobile.app',
      desc: 'React Native + Expo app — 56 screens, typed API client with automatic JWT refresh, secure keychain storage, push notifications, geolocation clock-in. Shipped through EAS to the App Store and Google Play.'
    },
    web: {
      name: 'web.portals',
      desc: 'Three server-rendered portals — admin, client, and employee — spanning 498 routes and 162 templates, backed by a versioned design-system package of 20 React components kept in lockstep with production CSS.'
    },
    api: {
      name: 'api.core',
      desc: 'Async FastAPI core: 159 REST endpoints for mobile plus 498 web routes. Dual session + JWT auth, configurable role-based permissions across 11 sections, and field-level encryption of PII at rest.'
    },
    workers: {
      name: 'workers.async',
      desc: 'Background loops on the event loop: timesheet auto-approval and Microsoft Graph mailbox sync every 15 minutes; shift reminders and onboarding document bundling every 60 seconds.'
    },
    db: {
      name: 'data.postgres',
      desc: 'PostgreSQL on Neon — 74 SQLAlchemy models evolved through 216 zero-downtime, in-place migrations, with slow-query and connection-pool observability built into the data layer.'
    },
    r2: {
      name: 'storage.r2',
      desc: 'S3-compatible object storage on Cloudflare R2 — resumes, IDs, profile photos, and signed government PDFs (I-9, W-4) across two isolated buckets with scoped access.'
    },
    ai: {
      name: 'ai.pipeline',
      desc: 'Claude for vision moderation and cost-flat incremental email summarization, OpenAI for approvals, LiteLLM for routing — plus a custom MCP server that lets AI agents operate the platform’s ticketing system.'
    },
    payroll: {
      name: 'integrations.payroll',
      desc: 'ADP payroll with certificate-based OAuth and onboarding push; Xero accounting sync with invoice generation; workers’-comp code tracking and a jurisdiction-aware minimum-wage engine.'
    },
    compliance: {
      name: 'integrations.compliance',
      desc: 'Direct DHS E-Verify integration including photo matching; WOTC 8850 batch filing; digital I-9, W-4, DE-4, and EEO-1 onboarding with real government PDFs filled programmatically; background checks via Accurate.'
    },
    comms: {
      name: 'integrations.comms',
      desc: 'Microsoft Graph mailbox sync, SES transactional email with 14 templates, web + mobile push behind a per-user preference matrix, Mapbox geocoding and distance checks, and PBX screen-pop telephony.'
    }
  };

  var archDetail = document.getElementById('arch-detail');
  var archNodes = document.querySelectorAll('.arch .node');
  if (archDetail && archNodes.length) {
    var nameEl = archDetail.querySelector('.name');
    var descEl = archDetail.querySelector('.desc');
    function selectNode(node) {
      var info = ARCH_DETAILS[node.getAttribute('data-node')];
      if (!info) return;
      archNodes.forEach(function (n) { n.classList.remove('active'); });
      node.classList.add('active');
      nameEl.textContent = info.name;
      descEl.textContent = info.desc;
    }
    archNodes.forEach(function (node) {
      node.addEventListener('mouseenter', function () { selectNode(node); });
      node.addEventListener('click', function () { selectNode(node); });
      node.addEventListener('focus', function () { selectNode(node); });
      node.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectNode(node);
        }
      });
    });
  }

  /* ── AI concierge chat (SSE streaming) ──────────────────── */
  var chatWindow = document.getElementById('chat-window');
  var chatForm = document.getElementById('chat-form');
  var chatInput = document.getElementById('chat-input');
  var chatPresets = document.getElementById('chat-presets');
  var history = [];
  var chatBusy = false;

  function addMsg(role, text, extraClass) {
    var el = document.createElement('div');
    el.className = 'msg ' + role + (extraClass ? ' ' + extraClass : '');
    el.textContent = text;
    chatWindow.appendChild(el);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return el;
  }

  function askConcierge(question) {
    if (chatBusy) return;
    var text = (question || '').trim();
    if (!text) return;
    chatBusy = true;
    addMsg('user', text);
    history.push({ role: 'user', content: text });
    chatInput.value = '';

    var aiMsg = addMsg('ai', 'thinking…', 'thinking');
    var answer = '';

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history })
    }).then(function (response) {
      var contentType = response.headers.get('content-type') || '';
      if (!response.ok || contentType.indexOf('text/event-stream') === -1) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          throw new Error(data.error || 'The concierge is unavailable right now — email Jake instead.');
        });
      }

      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function pump() {
        return reader.read().then(function (result) {
          if (result.done) return;
          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop() || '';
          lines.forEach(function (line) {
            if (line.indexOf('data:') !== 0) return;
            var payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') return;
            try {
              var event = JSON.parse(payload);
              if (event.text) {
                answer += event.text;
                aiMsg.classList.remove('thinking');
                aiMsg.textContent = answer;
                chatWindow.scrollTop = chatWindow.scrollHeight;
              }
            } catch (_) { /* skip malformed chunk */ }
          });
          return pump();
        });
      }
      return pump();
    }).then(function () {
      if (!answer) {
        aiMsg.classList.remove('thinking');
        aiMsg.textContent = 'No answer came back — try again, or email contact@jakebiddlecome.com.';
      } else {
        history.push({ role: 'assistant', content: answer });
      }
    }).catch(function (err) {
      aiMsg.classList.remove('thinking');
      aiMsg.textContent = err.message || 'The concierge is unavailable right now — email Jake instead.';
    }).finally(function () {
      chatBusy = false;
    });
  }

  if (chatForm) {
    chatForm.addEventListener('submit', function (e) {
      e.preventDefault();
      askConcierge(chatInput.value);
    });
  }
  if (chatPresets) {
    chatPresets.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-q]');
      if (btn) askConcierge(btn.getAttribute('data-q'));
    });
  }

  /* ── Chat bubble launcher ───────────────────────────────── */
  var chatBubble = document.getElementById('chat-bubble');
  var chatLauncher = document.getElementById('chat-launcher');
  var chatClose = document.getElementById('chat-close');
  if (chatBubble && chatLauncher) {
    var setChatOpen = function (open) {
      chatBubble.classList.toggle('open', open);
      chatLauncher.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && chatInput) chatInput.focus();
    };
    chatLauncher.addEventListener('click', function () {
      setChatOpen(!chatBubble.classList.contains('open'));
    });
    if (chatClose) {
      chatClose.addEventListener('click', function () {
        setChatOpen(false);
        chatLauncher.focus();
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && chatBubble.classList.contains('open')) {
        setChatOpen(false);
        chatLauncher.focus();
      }
    });
  }

  /* ── Contact form ───────────────────────────────────────── */
  var contactForm = document.getElementById('contact-form');
  var cfStatus = document.getElementById('cf-status');
  var cfSubmit = document.getElementById('cf-submit');

  if (contactForm) {
    contactForm.addEventListener('submit', function (e) {
      e.preventDefault();

      var data = {
        name: contactForm.name.value.trim(),
        email: contactForm.email.value.trim(),
        company: contactForm.company.value.trim(),
        interest: contactForm.interest.value,
        message: contactForm.message.value.trim(),
        website: contactForm.website.value
      };

      if (!data.name || !data.email || !data.message) {
        cfStatus.className = 'form-status err';
        cfStatus.textContent = 'name, email, and a short message are required.';
        return;
      }

      cfSubmit.disabled = true;
      cfStatus.className = 'form-status';
      cfStatus.textContent = 'sending…';

      fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          if (!response.ok) throw new Error(payload.error || 'Something went wrong.');
          contactForm.reset();
          cfStatus.className = 'form-status ok';
          cfStatus.textContent = '200 OK — received. I’ll reply within one business day.';
        });
      }).catch(function (err) {
        cfStatus.className = 'form-status err';
        cfStatus.textContent = (err.message || 'Something went wrong.') + ' You can also email contact@jakebiddlecome.com.';
      }).finally(function () {
        cfSubmit.disabled = false;
      });
    });
  }

  /* ── App screenshot gallery ─────────────────────────────── */
  var gallery = document.getElementById('gallery');
  if (gallery && typeof gallery.showModal === 'function') {
    var GROUPS = { employee: 'Employee app', client: 'Client app', web: 'Web portals' };
    // [group, caption, file id in assets/platform]
    var SHOTS = [
      ['employee', 'Home — confirmed shift', 'employee-dashboard-confirmed-shift'],
      ['employee', 'Home — on my way', 'employee-dashboard-on-my-way'],
      ['employee', 'Timeclock', 'employee-timeclock'],
      ['employee', 'Home — timesheet to review', 'employee-dashboard-with-timesheet'],
      ['employee', 'Find shifts map', 'employee-find-shifts-map'],
      ['employee', 'Shift request details', 'employee-shift-request-details'],
      ['employee', 'Event details', 'employee-event-details'],
      ['employee', 'Event details — venue', 'employee-event-details-2'],
      ['employee', 'Shift request notifications', 'employee-notifications-shift-request'],
      ['employee', 'Notification message', 'employee-notification-message'],
      ['employee', 'Onboarding', 'employee-onboarding'],
      ['employee', 'Tutorial', 'employee-tutorial'],
      ['employee', 'Tutorial, page 2', 'employee-tutorial-page-2'],
      ['employee', 'Choose positions', 'employee-choose-positions'],
      ['employee', 'Upload certificates', 'employee-upload-certificates'],
      ['employee', 'Uniform & professional photos', 'employee-uniform-professional-photos'],
      ['employee', 'Profile & badges', 'employee-profile-badges'],
      ['employee', 'Profile menu', 'employee-profile-menu'],
      ['employee', 'Ratings', 'employee-ratings-page'],
      ['employee', 'Sick & vacation requests', 'employee-sick-vacation-requests'],
      ['client', 'Client dashboard', 'client-dashboard-page'],
      ['client', 'Events list', 'client-events-list'],
      ['client', 'Event page', 'client-event-page'],
      ['client', 'Add shift — choose position', 'client-add-shift-choose-position'],
      ['client', 'Add shift — set time', 'client-add-shift-set-time'],
      ['client', 'Add shift — uniform & post', 'client-add-shift-uniform-and-post'],
      ['client', 'Request an employee', 'client-request-employee'],
      ['client', 'Employee details', 'client-employee-details'],
      ['client', 'Employee experience summary', 'client-employee-experience'],
      ['client', 'Employee photo', 'client-view-employee-photo'],
      ['client', 'Employee uniform check', 'client-view-employee-uniform'],
      ['client', 'Message an employee', 'client-message-employee'],
      ['client', 'Review timesheets', 'client-review-timesheets'],
      ['client', 'Approved timesheets', 'client-approved-timesheets'],
      ['client', 'Ratings', 'client-ratings-page'],
      ['web', 'Employee portal — home', 'web-employee-home'],
      ['web', 'Employee portal — calendar', 'web-employee-calendar'],
      ['web', 'Employee portal — shift details', 'web-shift-details'],
      ['web', 'Client portal — event & reviews', 'web-client-event-reviews'],
      ['web', 'Admin — employee reviews', 'web-admin-employee-reviews'],
      ['web', 'Admin — message the crew', 'web-admin-message-crew'],
      ['web', 'Admin — certifications catalog', 'web-admin-certifications']
    ];
    var galleryBody = document.getElementById('gallery-body');
    var lightbox = document.getElementById('lightbox');
    var lbImg = document.getElementById('lightbox-img');
    var lbCaption = document.getElementById('lightbox-caption');
    var tabs = gallery.querySelectorAll('[data-filter]');
    var filter = 'all';
    var current = 0;
    var closeWithLightbox = false;

    function shotSrc(shot) { return 'assets/platform/' + shot[2] + '.webp'; }

    Object.keys(GROUPS).forEach(function (group) {
      var section = document.createElement('section');
      section.className = 'gallery-group';
      section.dataset.group = group;
      var heading = document.createElement('h3');
      heading.textContent = GROUPS[group];
      var grid = document.createElement('div');
      grid.className = 'gallery-grid' + (group === 'web' ? ' is-web' : '');
      SHOTS.forEach(function (shot, i) {
        if (shot[0] !== group) return;
        var tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'tile';
        var img = document.createElement('img');
        img.src = shotSrc(shot);
        img.alt = GROUPS[group] + ': ' + shot[1];
        img.loading = 'lazy';
        var label = document.createElement('span');
        label.textContent = shot[1];
        tile.appendChild(img);
        tile.appendChild(label);
        tile.addEventListener('click', function () { openShot(i, false); });
        grid.appendChild(tile);
      });
      section.appendChild(heading);
      section.appendChild(grid);
      galleryBody.appendChild(section);
    });
    var sections = galleryBody.querySelectorAll('.gallery-group');

    function setFilter(next) {
      filter = next;
      tabs.forEach(function (tab) { tab.setAttribute('aria-pressed', String(tab.dataset.filter === next)); });
      sections.forEach(function (section) { section.hidden = next !== 'all' && section.dataset.group !== next; });
      galleryBody.scrollTop = 0;
    }

    function showShot() {
      var shot = SHOTS[current];
      lbImg.src = shotSrc(shot);
      lbImg.alt = GROUPS[shot[0]] + ': ' + shot[1];
      lbCaption.textContent = GROUPS[shot[0]] + ' · ' + shot[1];
    }

    function openShot(index, fromShowcase) {
      current = index;
      closeWithLightbox = fromShowcase;
      showShot();
      lightbox.hidden = false;
      document.getElementById('lb-next').focus();
    }

    function step(delta) {
      var pool = [];
      SHOTS.forEach(function (shot, i) { if (filter === 'all' || shot[0] === filter) pool.push(i); });
      var pos = pool.indexOf(current);
      current = pool[(pos + delta + pool.length) % pool.length];
      showShot();
    }

    function closeLightbox() {
      lightbox.hidden = true;
      if (closeWithLightbox) gallery.close();
    }

    function openGallery() {
      setFilter('all');
      lightbox.hidden = true;
      if (!gallery.open) gallery.showModal();
    }

    document.getElementById('gallery-open').addEventListener('click', openGallery);
    document.querySelectorAll('[data-shot]').forEach(function (trigger) {
      trigger.addEventListener('click', function () {
        var index = SHOTS.findIndex(function (shot) { return shot[2] === trigger.dataset.shot; });
        if (index < 0) return;
        openGallery();
        openShot(index, true);
      });
    });
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { setFilter(tab.dataset.filter); });
    });
    document.getElementById('gallery-close').addEventListener('click', function () { gallery.close(); });
    document.getElementById('lb-close').addEventListener('click', closeLightbox);
    document.getElementById('lb-prev').addEventListener('click', function () { step(-1); });
    document.getElementById('lb-next').addEventListener('click', function () { step(1); });

    gallery.addEventListener('cancel', function (e) {
      if (!lightbox.hidden && !closeWithLightbox) {
        e.preventDefault();
        lightbox.hidden = true;
      }
    });
    gallery.addEventListener('click', function (e) {
      if (e.target === gallery) gallery.close();
    });
    gallery.addEventListener('keydown', function (e) {
      if (lightbox.hidden) return;
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
    });

    var touchX = null;
    lightbox.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
    lightbox.addEventListener('touchend', function (e) {
      if (touchX === null) return;
      var dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
      touchX = null;
    });
  }
})();
