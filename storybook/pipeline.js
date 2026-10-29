// The Orchestrator: runs each stage in order, saves a checkpoint after every one, and stops
// whenever a person needs to approve or decide something. A book is a small state machine:
//
//   research → outline → [you approve the outline] → story (Writer ⇄ Editor) → [you approve the text]
//   → art_plan → illustrations (Illustrator ⇄ Art Reviewer, in parallel) → [you decide on flagged pictures]
//   → assemble → done
//
// Any agent can also stop the line with NeedsDirection (see common.js); the book then waits for you.
const store = require('./store');
const { NeedsDirection } = require('./common');
const { BookText } = require('./models');
const { runResearcher } = require('./researcher');
const { runOutliner, writeAndEdit } = require('./story');
const { runArtDirector, illustrate } = require('./art');
const { assemble } = require('./assembler');

const active = new Set(); // books being worked on by this server process right now

const isBusy = () => active.size > 0;

function makeContext(book) {
  return {
    costs: book.costs || {},
    async log(agent, message) {
      console.log(`storybook #${book.id} ${agent}: ${message}`);
      await store.addEvent(book.id, agent, message);
    },
  };
}

const total = (costs) => Object.values(costs).reduce((a, b) => a + b, 0);

// One step of work for the book's current stage. Returns false when the book should stop and wait.
async function runStage(book, ctx) {
  const { data, request } = book;
  const save = (fields = {}) => store.updateBook(book.id, { data, costs: ctx.costs, ...fields });

  switch (book.stage) {
    case 'research':
      data.research = await runResearcher(ctx, request, data.guidance);
      await save({ stage: 'outline' });
      return true;

    case 'outline':
      data.outline = await runOutliner(ctx, request, data.research,
        { guidance: data.guidance, previous: data.outline_notes ? data.outline : null, notes: data.outline_notes });
      data.outline_notes = null;
      await save({ title: data.outline.title, stage: 'outline_review', status: 'awaiting_approval',
        pending: { kind: 'approve_outline', question: 'Approve the outline, or tell the Outliner what to change.' } });
      return false;

    case 'story': {
      const result = await writeAndEdit(ctx, request, data.outline, data.research,
        { guidance: data.guidance, draft: data.story_notes ? data.story : null, notes: data.story_notes });
      data.story = result.story;
      data.story_review = result.review;
      data.story_notes = null;
      const pending = result.approved
        ? { kind: 'approve_story', question: 'The Editor approved this text. Approve it, edit it, or ask for changes.' }
        : { kind: 'approve_story', blocked: true,
            question: "The Writer and Editor couldn't agree after 3 rounds. Read the Editor's remaining issues, then " +
              'approve the text as it is (you can edit it), or give the Writer direction.' };
      await save({ title: data.story.title, stage: 'story_review', status: result.approved ? 'awaiting_approval' : 'needs_direction', pending });
      return false;
    }

    case 'art_plan':
      data.art_plan = await runArtDirector(ctx, request, data.story, data.outline);
      data.pictures = {};
      await save({ stage: 'illustrations' });
      return true;

    case 'illustrations': {
      const flagged = await illustrate(ctx, book.id, data.art_plan, data.outline, data.story, data.pictures, () => save());
      if (flagged.length) {
        await save({ stage: 'illustrations_review', status: 'needs_direction', pending: { kind: 'review_pictures', pictures: flagged,
          question: `The Art Reviewer couldn't approve ${flagged.length} picture(s), even after redrawing. Accept each one as it is, or tell the Illustrator what to change.` } });
        return false;
      }
      await save({ stage: 'assemble' });
      return true;
    }

    case 'assemble':
      await ctx.log('assembler', 'laying out the PDF');
      await store.putPdf(book.id, await assemble(book.id, data.story));
      await save({ stage: 'done', status: 'done', pending: null });
      await ctx.log('orchestrator', `finished. Total cost $${total(ctx.costs).toFixed(2)}`);
      return false;

    default:
      return false; // waiting stages (outline_review, story_review, illustrations_review) and done
  }
}

// Run a book forward until it finishes, fails, or needs a person. Safe to call without awaiting.
async function run(bookId) {
  if (active.has(bookId)) return;
  active.add(bookId);
  let book = await store.getBook(bookId);
  const ctx = makeContext(book);
  try {
    await store.updateBook(bookId, { status: 'running', error: null, pending: null });
    for (;;) {
      book = await store.getBook(bookId);
      const started = Date.now();
      const spent = total(ctx.costs);
      await ctx.log('orchestrator', `${book.stage}: starting`);
      const keepGoing = await runStage(book, ctx);
      await ctx.log('orchestrator', `${book.stage}: done in ${Math.round((Date.now() - started) / 1000)}s, $${(total(ctx.costs) - spent).toFixed(2)}`);
      if (!keepGoing) break;
    }
  } catch (err) {
    if (err instanceof NeedsDirection) {
      await ctx.log('orchestrator', 'waiting for your direction');
      const data = book.data;
      if (err.details.partial) data.partial_research = err.details.partial;
      await store.updateBook(bookId, { status: 'needs_direction', data, costs: ctx.costs,
        pending: { kind: 'direction', question: err.question, allow_continue: Boolean(err.details.allow_continue) } });
    } else {
      console.error(`storybook #${bookId} failed:`, err);
      await ctx.log('orchestrator', `stopped: ${err.message}`);
      await store.updateBook(bookId, { status: 'failed', error: err.message, costs: ctx.costs });
    }
  } finally {
    active.delete(bookId);
  }
}

async function startBook(request) {
  const id = await store.createBook(request);
  run(id);
  return id;
}

const addGuidance = (data, notes) => { data.guidance = [data.guidance, notes].filter(Boolean).join('\n'); };

// Apply a person's decision to a waiting book, then set it running again.
async function decide(bookId, body) {
  const book = await store.getBook(bookId);
  if (!book) throw Object.assign(new Error('No such book.'), { status: 404 });
  if (!['awaiting_approval', 'needs_direction', 'failed'].includes(book.status)) {
    throw Object.assign(new Error('This book is not waiting for a decision.'), { status: 409 });
  }
  const { action } = body;
  const notes = String(body.notes || '').trim().slice(0, 4000);
  const needNotes = () => { if (!notes) throw Object.assign(new Error('Please write some direction first.'), { status: 400 }); };
  const data = book.data;
  const kind = book.status === 'failed' ? 'failed' : book.pending?.kind;
  let stage = book.stage;

  if (action === 'cancel') {
    await store.updateBook(bookId, { status: 'cancelled', pending: null });
    await store.addEvent(bookId, 'you', 'cancelled the book');
    return;
  }

  if (kind === 'failed' && action === 'retry') {
    // Resume from the last checkpoint.
  } else if (kind === 'approve_outline' && action === 'approve') {
    stage = 'story';
  } else if (kind === 'approve_outline' && action === 'revise') {
    needNotes(); data.outline_notes = notes; stage = 'outline';
  } else if (kind === 'approve_story' && action === 'approve') {
    if (body.story) data.story = BookText.parse(body.story); // your edits to the text, if any
    stage = 'art_plan';
  } else if (kind === 'approve_story' && action === 'revise') {
    needNotes(); data.story_notes = notes; stage = 'story';
  } else if (kind === 'direction' && action === 'guide') {
    needNotes(); addGuidance(data, notes);
  } else if (kind === 'direction' && action === 'continue' && book.pending.allow_continue && data.partial_research) {
    data.research = data.partial_research; stage = 'outline';
  } else if (kind === 'review_pictures' && action === 'submit') {
    for (const name of book.pending.pictures) {
      const choice = (body.pictures || {})[name] || {};
      const pictureNotes = String(choice.notes || '').trim().slice(0, 1000);
      if (choice.action === 'redraw') {
        if (!pictureNotes) throw Object.assign(new Error(`Say what to change for ${name}, or accept it.`), { status: 400 });
        data.pictures[name] = { status: 'pending', redraw: true, human_notes: pictureNotes, issues: [] };
      } else {
        data.pictures[name] = { ...data.pictures[name], status: 'accepted' };
      }
    }
    stage = 'illustrations';
  } else {
    throw Object.assign(new Error('That action does not fit what this book is waiting for.'), { status: 400 });
  }

  await store.addEvent(bookId, 'you', describeDecision(kind, action, notes));
  await store.updateBook(bookId, { data, stage, status: 'running', pending: null, error: null });
  run(bookId);
}

function describeDecision(kind, action, notes) {
  if (action === 'retry') return 'retried from the last checkpoint';
  if (action === 'approve') return kind === 'approve_outline' ? 'approved the outline' : 'approved the text';
  if (action === 'continue') return 'continued with the facts found so far';
  if (action === 'submit') return 'decided on the flagged pictures';
  return `gave direction: ${notes.slice(0, 200)}`;
}

module.exports = { startBook, decide, isBusy, run };
