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
        aiMsg.textContent = 'No answer came back — try again, or email jake.biddlecome@gmail.com.';
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
        cfStatus.textContent = (err.message || 'Something went wrong.') + ' You can also email jake.biddlecome@gmail.com.';
      }).finally(function () {
        cfSubmit.disabled = false;
      });
    });
  }
})();
