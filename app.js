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

  /* ── Nav border once scrolled ──────────────────────────── */
  var nav = document.querySelector('.nav');
  if (nav) {
    var onScroll = function () { nav.classList.toggle('scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ── Hero: manual tasks snap into a pipeline ────────────── */
  var flow = document.getElementById('flow');
  var flowReplay = document.getElementById('flow-replay');
  if (flow) {
    var flowTimers = [];
    var playFlow = function () {
      flowTimers.forEach(clearTimeout);
      flow.classList.remove('messy', 'aligned', 'done');
      if (reducedMotion) { flow.classList.add('messy', 'aligned', 'done'); return; }
      flowTimers = [
        setTimeout(function () { flow.classList.add('messy'); }, 1700),
        setTimeout(function () { flow.classList.add('aligned'); }, 1750),
        setTimeout(function () { flow.classList.add('done'); }, 2900)
      ];
    };
    playFlow();
    if (flowReplay) flowReplay.addEventListener('click', playFlow);
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
          throw new Error(data.error || 'The assistant is unavailable right now. Email Jake at contact@jakebiddlecome.com instead.');
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
      aiMsg.textContent = err.message || 'The assistant is unavailable right now. Email Jake at contact@jakebiddlecome.com instead.';
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
        cfStatus.textContent = 'Name, email, and a short message are required.';
        return;
      }

      cfSubmit.disabled = true;
      cfStatus.className = 'form-status';
      cfStatus.textContent = 'Sending…';

      fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          if (!response.ok) throw new Error(payload.error || 'Something went wrong.');
          contactForm.reset();
          cfStatus.className = 'form-status ok';
          cfStatus.textContent = 'Thanks, your message is on its way. I’ll reply within one business day.';
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
