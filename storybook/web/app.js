// /storybook front end: start books, watch the agents work, and make the decisions they stop for.
const $ = (id) => document.getElementById(id);
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS_LABELS = {
  running: 'Agents working', awaiting_approval: 'Needs your approval', needs_direction: 'Needs your direction',
  failed: 'Stopped', done: 'Finished', cancelled: 'Cancelled',
};
// The pipeline's stages in order; `you: true` marks the points where a person decides.
const STAGES = [
  { id: 'research', label: 'Research' },
  { id: 'outline', label: 'Outline' },
  { id: 'outline_review', label: 'You: approve outline', you: true },
  { id: 'story', label: 'Write ⇄ Edit' },
  { id: 'story_review', label: 'You: approve text', you: true },
  { id: 'art_plan', label: 'Art direction' },
  { id: 'illustrations', label: 'Draw ⇄ Review' },
  { id: 'illustrations_review', label: 'You: flagged pictures', you: true },
  { id: 'assemble', label: 'Assemble PDF' },
  { id: 'done', label: 'Done' },
];
const AGENT_NAMES = {
  orchestrator: 'Orchestrator', researcher: 'Researcher', outliner: 'Outliner', writer: 'Writer', editor: 'Editor',
  art_director: 'Art Director', illustrator: 'Illustrator', art_reviewer: 'Art Reviewer', assembler: 'Assembler', you: 'You',
};

async function api(path, options = {}) {
  const res = await fetch(`/storybook/api${path}`, {
    ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 401) { location.reload(); throw new Error('Login required.'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}

$('logout').addEventListener('click', async () => {
  await fetch('/storybook/api/logout', { method: 'POST' });
  location.href = '/storybook';
});

// ── Home ──────────────────────────────────────────────────────────────────────
async function loadBooks() {
  const { books } = await api('/books');
  $('books').innerHTML = books.length ? books.map((b) => {
    const cost = Object.values(b.costs || {}).reduce((a, c) => a + c, 0);
    return `<li>
      <div><a href="/storybook?id=${b.id}">${esc(b.title || b.request.subject)}</a>
        <div class="meta">${esc(b.request.story_type)} · ages ${esc(b.request.age_group)} · $${cost.toFixed(2)}</div></div>
      <span class="badge ${esc(b.status)}">${esc(STATUS_LABELS[b.status] || b.status)}</span>
    </li>`;
  }).join('') : '<li class="muted">No books yet.</li>';
}

$('book-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  data.page_count = Number(data.page_count);
  $('go').disabled = true;
  $('form-error').classList.add('hidden');
  try {
    const { id } = await api('/books', { method: 'POST', body: JSON.stringify(data) });
    location.href = `/storybook?id=${id}`;
  } catch (err) {
    $('form-error').textContent = err.message;
    $('form-error').classList.remove('hidden');
    $('go').disabled = false;
  }
});

// ── One book ──────────────────────────────────────────────────────────────────
const bookId = Number(new URLSearchParams(location.search).get('id'));
let lastEventId = 0;
let pollTimer = null;
let shownDecisionKey = null; // so polling doesn't wipe a half-written note

async function refresh() {
  const { book, events } = await api(`/books/${bookId}?after=${lastEventId}`);
  appendEvents(events);
  renderHeader(book);
  renderCost(book.costs);
  renderPictures(book);
  renderDecision(book);
  renderResult(book);
  clearTimeout(pollTimer);
  if (book.status === 'running') pollTimer = setTimeout(() => refresh().catch(showPollError), 2500);
}

function showPollError(err) {
  console.error(err);
  pollTimer = setTimeout(() => refresh().catch(showPollError), 5000);
}

function appendEvents(events) {
  if (!events.length) return;
  const log = $('log');
  for (const e of events) {
    const time = new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const cls = e.agent === 'you' ? 'you' : 'agent';
    log.insertAdjacentHTML('beforeend', `<div><span class="muted">${time}</span> <span class="${cls}">${esc(AGENT_NAMES[e.agent] || e.agent)}</span> ${esc(e.message)}</div>`);
    lastEventId = Math.max(lastEventId, e.id);
  }
  log.scrollTop = log.scrollHeight;
}

function renderHeader(book) {
  const r = book.request;
  document.title = `${book.title || r.subject} · Storybook`;
  $('book-title').textContent = book.title || `A book about ${r.subject}`;
  $('book-request').textContent = `${r.story_type} · ages ${r.age_group} · ${r.style} · ${r.page_count} pages`;
  $('book-status').className = `badge ${book.status}`;
  $('book-status').textContent = STATUS_LABELS[book.status] || book.status;
  const current = STAGES.findIndex((s) => s.id === book.stage);
  $('stages').innerHTML = STAGES.map((s, i) => {
    const cls = [s.you ? 'you' : '', i < current ? 'done' : '', i === current && book.status !== 'done' ? 'current' : '',
      book.status === 'done' ? 'done' : ''].join(' ');
    return `<li class="${cls}">${esc(s.label)}</li>`;
  }).join('');
}

function renderCost(costs = {}) {
  const entries = Object.entries(costs);
  const total = entries.reduce((a, [, c]) => a + c, 0);
  $('cost-total').textContent = `$${total.toFixed(2)}`;
  $('cost-detail').textContent = entries.sort((a, b) => b[1] - a[1]).map(([a, c]) => `${AGENT_NAMES[a] || a} $${c.toFixed(2)}`).join(' · ');
}

function imageUrl(book, name) {
  return `/storybook/api/books/${book.id}/images/${name}?v=${encodeURIComponent(book.updated_at)}`;
}

function renderPictures(book) {
  const pictures = book.data.pictures;
  if (!pictures || !Object.keys(pictures).length) { $('pictures-card').classList.add('hidden'); return; }
  const names = ['characters', ...Object.keys(pictures).sort()];
  const label = { approved: 'approved', accepted: 'accepted by you', flagged: 'needs you', pending: 'redrawing' };
  $('gallery').innerHTML = names.map((name) => `<figure>
      <img src="${imageUrl(book, name)}" alt="${esc(name)}" loading="lazy" onerror="this.style.visibility='hidden'">
      <figcaption><span>${esc(name.replace('_', ' '))}</span><span class="muted">${esc(label[pictures[name]?.status] || (name === 'characters' ? 'reference' : ''))}</span></figcaption>
    </figure>`).join('');
  $('pictures-card').classList.remove('hidden');
}

function renderResult(book) {
  if (book.status !== 'done' || !book.has_pdf) { $('result').classList.add('hidden'); return; }
  const url = `/storybook/api/books/${book.id}/pdf`;
  $('pdf-link').href = url;
  if ($('pdf-frame').getAttribute('src') !== url) $('pdf-frame').src = url;
  $('result').classList.remove('hidden');
}

// ── Decisions ─────────────────────────────────────────────────────────────────
function renderDecision(book) {
  const box = $('decision');
  const waiting = ['awaiting_approval', 'needs_direction', 'failed'].includes(book.status);
  if (!waiting) { box.classList.add('hidden'); shownDecisionKey = null; return; }
  const key = `${book.status}:${book.stage}:${book.updated_at}`;
  if (key === shownDecisionKey) return;
  shownDecisionKey = key;

  const kind = book.status === 'failed' ? 'failed' : book.pending?.kind;
  const render = { approve_outline: outlinePanel, approve_story: storyPanel, direction: directionPanel,
    review_pictures: picturesPanel, failed: failedPanel }[kind];
  box.innerHTML = render ? render(book) : '<p>This book is waiting, but the page does not know how to show it.</p>';
  box.classList.remove('hidden');
  wireDecision(book, kind);
}

const notesBox = (placeholder) => `<label>Direction for the agents
  <textarea id="notes" placeholder="${esc(placeholder)}"></textarea></label>`;
const cancelButton = '<button class="secondary" data-action="cancel">Cancel this book</button>';

function outlinePanel(book) {
  const o = book.data.outline;
  return `<h2>Approve the outline</h2>
    <p class="muted">${esc(book.pending.question)} Nothing has been written or drawn yet, so changes here are cheap.</p>
    <h3>${esc(o.title)}</h3>
    <p><strong>Story:</strong> ${esc(o.logline)}<br><strong>Theme:</strong> ${esc(o.theme)}<br><strong>Setting:</strong> ${esc(o.setting)}</p>
    <h3>Characters</h3>
    <ul class="outline-pages">${o.characters.map((c) => `<li><strong>${esc(c.name)}</strong> (${esc(c.role)}): ${esc(c.appearance)}</li>`).join('')}</ul>
    <h3>Pages</h3>
    <ol class="outline-pages">${o.pages.map((p) => `<li>${esc(p.what_happens)} <span class="muted small">Picture: ${esc(p.illustration_idea)}</span></li>`).join('')}</ol>
    <h3>Research it's built on</h3>
    <ul class="outline-pages small">${book.data.research.facts.map((f) => `<li>${esc(f.kid_friendly)} <a href="${esc(f.source_url)}" target="_blank" rel="noopener">source</a></li>`).join('')}</ul>
    <div class="actions"><button data-action="approve">Approve outline</button></div>
    ${notesBox('e.g. Make the turtle a grandmother, and end at sunset instead of noon.')}
    <div class="actions"><button class="secondary" data-action="revise">Ask the Outliner for changes</button>${cancelButton}</div>
    <p class="error hidden" id="decision-error"></p>`;
}

function storyPanel(book) {
  const s = book.data.story;
  const review = book.data.story_review || { issues: [] };
  const mustFix = review.issues.filter((i) => i.severity === 'must_fix');
  const polish = review.issues.filter((i) => i.severity !== 'must_fix');
  const issueList = (list) => `<ul class="issues">${list.map((i) => `<li><strong>${i.page_number ? `Page ${i.page_number}` : 'Whole book'}:</strong> ${esc(i.problem)} <span class="muted small">Suggestion: ${esc(i.suggestion)}</span></li>`).join('')}</ul>`;
  return `<h2>${book.pending.blocked ? 'The Writer and Editor need you' : 'Approve the text'}</h2>
    <p class="muted">${esc(book.pending.question)} You can edit any page directly below before approving.</p>
    ${mustFix.length ? `<h3>Editor's unresolved issues</h3>${issueList(mustFix)}` : ''}
    ${polish.length ? `<details><summary class="small muted">Editor's polish suggestions (${polish.length})</summary>${issueList(polish)}</details>` : ''}
    <h3>Text</h3>
    <label class="page-edit">Title <input id="edit-title" value="${esc(s.title)}"></label>
    ${s.pages.map((p) => `<label class="page-edit">Page ${p.page_number}
      <textarea data-page="${p.page_number}">${esc(p.text)}</textarea></label>`).join('')}
    <div class="actions"><button data-action="approve">Approve text${book.pending.blocked ? ' as it is' : ''}</button></div>
    ${notesBox('e.g. Add more rhyme on pages 2-4, and give Pip one funny line at the end.')}
    <div class="actions"><button class="secondary" data-action="revise">Ask the Writer for changes</button>${cancelButton}</div>
    <p class="error hidden" id="decision-error"></p>`;
}

function directionPanel(book) {
  const partial = book.data.partial_research;
  return `<h2>The agents need direction</h2>
    <p>${esc(book.pending.question)}</p>
    ${notesBox('Answer the question, or explain what you have in mind.')}
    <div class="actions"><button data-action="guide">Continue with this direction</button>
    ${book.pending.allow_continue && partial ? `<button class="secondary" data-action="continue">Continue anyway with ${partial.facts.length} facts</button>` : ''}
    ${cancelButton}</div>
    <p class="error hidden" id="decision-error"></p>`;
}

function picturesPanel(book) {
  return `<h2>Pictures that need your eyes</h2>
    <p class="muted">${esc(book.pending.question)}</p>
    ${book.pending.pictures.map((name) => {
      const p = book.data.pictures[name] || { issues: [] };
      return `<div class="flagged" data-picture="${esc(name)}">
        <img src="${imageUrl(book, name)}" alt="${esc(name)}">
        <div>
          <h3 style="margin-top:0">${esc(name.replace('_', ' '))}</h3>
          <ul class="issues small">${p.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
          <div class="choice">
            <label><input type="radio" name="pick-${esc(name)}" value="accept" checked> Accept as it is</label>
            <label><input type="radio" name="pick-${esc(name)}" value="redraw"> Redraw it</label>
          </div>
          <textarea class="picture-notes" placeholder="If redrawing: what should change?"></textarea>
        </div>
      </div>`;
    }).join('')}
    <div class="actions"><button data-action="submit">Send my decisions</button>${cancelButton}</div>
    <p class="error hidden" id="decision-error"></p>`;
}

function failedPanel(book) {
  return `<h2>The agents stopped</h2>
    <p>${esc(book.error || 'Something went wrong.')}</p>
    <p class="muted small">Everything finished before this point is saved. Retrying starts from the last checkpoint, so you don't pay twice.</p>
    <div class="actions"><button data-action="retry">Retry from the last checkpoint</button>${cancelButton}</div>
    <p class="error hidden" id="decision-error"></p>`;
}

function wireDecision(book, kind) {
  for (const button of $('decision').querySelectorAll('button[data-action]')) {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;
      if (action === 'cancel' && !confirmCancel()) return;
      const body = { action, notes: $('notes')?.value || '' };
      if (kind === 'approve_story' && action === 'approve') {
        body.story = {
          title: $('edit-title').value.trim(),
          pages: [...document.querySelectorAll('textarea[data-page]')].map((t) => ({ page_number: Number(t.dataset.page), text: t.value.trim() })),
        };
      }
      if (kind === 'review_pictures') {
        body.pictures = {};
        for (const el of document.querySelectorAll('[data-picture]')) {
          body.pictures[el.dataset.picture] = {
            action: el.querySelector('input[type=radio]:checked').value,
            notes: el.querySelector('.picture-notes').value,
          };
        }
      }
      for (const b of $('decision').querySelectorAll('button')) b.disabled = true;
      try {
        await api(`/books/${book.id}/decision`, { method: 'POST', body: JSON.stringify(body) });
        shownDecisionKey = null;
        await refresh();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (err) {
        $('decision-error').textContent = err.message;
        $('decision-error').classList.remove('hidden');
        for (const b of $('decision').querySelectorAll('button')) b.disabled = false;
      }
    });
  }
}

// A plain confirm() would block the page; a second click within 4 seconds confirms instead.
let cancelArmedUntil = 0;
function confirmCancel() {
  if (Date.now() < cancelArmedUntil) return true;
  cancelArmedUntil = Date.now() + 4000;
  $('decision-error').textContent = 'Click "Cancel this book" again to confirm.';
  $('decision-error').classList.remove('hidden');
  return false;
}

let deleteArmedUntil = 0;
$('delete-book').addEventListener('click', async () => {
  if (Date.now() > deleteArmedUntil) {
    deleteArmedUntil = Date.now() + 4000;
    $('delete-book').textContent = 'Click again to delete for good';
    setTimeout(() => { $('delete-book').textContent = 'Delete this book'; }, 4000);
    return;
  }
  try {
    await api(`/books/${bookId}`, { method: 'DELETE' });
    location.href = '/storybook';
  } catch (err) {
    $('delete-book').textContent = err.message;
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
if (bookId) {
  $('home').classList.add('hidden');
  $('book').classList.remove('hidden');
  refresh().catch((err) => { $('log').textContent = err.message; });
} else {
  loadBooks().catch((err) => { $('books').innerHTML = `<li class="error">${esc(err.message)}</li>`; });
}
