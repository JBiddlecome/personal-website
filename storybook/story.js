// The Outliner, Writer and Editor: from research to approved page text.
const { ask, NeedsDirection } = require('./common');
const { BookOutline, BookText, EditorReview } = require('./models');

const MAX_ROUNDS = 3;

const OUTLINER_SYSTEM = `You are a children's book story editor who plans picture books before they are written.

Your job is to produce a page-by-page outline, not the finished text.

Guidelines:
- Match the story's vocabulary, length and themes to the reader's age group.
- Follow the conventions of the requested story type (for example, a fable ends
  with a clear moral; a rhyming poem needs a strong, simple rhythm).
- Give the story a clear beginning, a problem, a turning point and a satisfying ending.
- Keep the cast small (two to four characters) so young readers can follow it.
- Every page needs something visual happening that an illustrator can draw.
- Build the plot around two or three of the researched facts, so the real
  facts drive the story instead of being tacked on.
- Direction from the person making the book outranks these guidelines.`;

const WRITER_SYSTEM = `You are a children's picture book author.

You receive a page-by-page outline and a set of researched facts, and you write
the words for each page.

- Follow the outline's events, page by page. Keep the same title and characters.
- Write for the reader's age group: short sentences, familiar words, and text
  that is fun to read aloud (repetition, sound words, a little rhythm).
- Weave in a few of the researched facts where they fit the story naturally.
  Never invent facts; if a fact isn't in the research, leave it out.
- Match the requested style and story type.
- Don't ask readers to count things in the pictures; illustrators can't guarantee exact numbers.
- Don't describe actions an illustrator can't show clearly (like flying backward).
- If you are given notes, revise the previous draft: notes from the person making
  the book come first, then every must_fix issue from the editor. Keep what was praised.`;

const EDITOR_SYSTEM = `You are a demanding but fair children's book editor. You review a draft and
return notes; you never rewrite the book yourself.

Check every page against this list:
1. Age fit: words, sentence length and ideas suit the reader's age group.
2. Read-aloud quality: rhythm, flow, fun sounds; no tongue-twisters by accident.
3. Story: it follows the outline, makes sense, and the ending lands the theme.
4. Accuracy: every factual claim appears in the provided research. Flag anything
   presented as fact that the research doesn't support.
5. Consistency: names, details and tone stay the same across pages.
6. Safety: nothing frightening, unkind or inappropriate for the age group.
7. Direction: anything the person making the book asked for has been done.

Severity:
- must_fix: a real problem a parent or teacher would notice.
- nice_to_have: polish. Don't invent problems; a short list is fine if the draft is good.`;

const summary = (r) => `Age group: ${r.age_group}\nStyle: ${r.style}\nStory type: ${r.story_type}\nSubject: ${r.subject}\nPages: ${r.page_count}`;
const factsText = (research) => research.facts.map((f) => `- ${f.kid_friendly}`).join('\n');
const direction = (guidance) => (guidance ? `\n\nDIRECTION FROM THE PERSON MAKING THE BOOK:\n${guidance}` : '');

async function runOutliner(ctx, request, research, { guidance, previous, notes } = {}) {
  let content = `Plan a ${request.page_count}-page children's book.\n${summary(request)}\n\nRESEARCHED FACTS:\n${factsText(research)}${direction(guidance)}`;
  if (previous && notes) {
    content += `\n\nYOUR PREVIOUS OUTLINE:\n${JSON.stringify(previous, null, 2)}\n\nTHE PERSON'S NOTES ON IT (apply all of them):\n${notes}`;
  }
  await ctx.log('outliner', previous ? 'revising the outline' : 'planning the pages');
  const outline = await ask(ctx, 'outliner', { system: OUTLINER_SYSTEM, content, schema: BookOutline });
  if (outline.needs_direction) {
    await ctx.log('outliner', 'stopped to ask for direction');
    throw new NeedsDirection(outline.needs_direction);
  }
  return outline;
}

// Writer drafts, Editor reviews, our code decides. Returns the last draft and whether the Editor approved it.
async function writeAndEdit(ctx, request, outline, research, { guidance, draft = null, notes = null } = {}) {
  const context = `${summary(request)}\n\nOUTLINE:\n${JSON.stringify(outline, null, 2)}\n\nRESEARCHED FACTS:\n${JSON.stringify(research.facts, null, 2)}${direction(guidance)}`;
  let review = null;
  const rounds = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let content = context;
    if (draft && (review || notes)) {
      content += `\n\nYOUR PREVIOUS DRAFT:\n${JSON.stringify(draft, null, 2)}`;
      if (notes) content += `\n\nNOTES FROM THE PERSON MAKING THE BOOK (do all of these):\n${notes}`;
      if (review) content += `\n\nEDITOR'S NOTES:\n${JSON.stringify(review, null, 2)}`;
      content += '\n\nWrite the revised draft.';
    } else {
      content += '\n\nWrite the first draft.';
    }
    await ctx.log('writer', `round ${round}: ${draft ? 'revising' : 'drafting'}`);
    draft = await ask(ctx, 'writer', { system: WRITER_SYSTEM, content, schema: BookText });

    let reviewContent = `${context}\n\nDRAFT TO REVIEW:\n${JSON.stringify(draft, null, 2)}`;
    if (notes) reviewContent += `\n\nTHE PERSON ASKED FOR THESE CHANGES (check they were made):\n${notes}`;
    review = await ask(ctx, 'editor', { system: EDITOR_SYSTEM, content: reviewContent, schema: EditorReview });
    rounds.push({ draft, review });

    const mustFix = review.issues.filter((i) => i.severity === 'must_fix');
    await ctx.log('editor', `round ${round}: ${mustFix.length} must-fix issue(s)`);
    if (!mustFix.length) {
      await ctx.log('editor', 'approved');
      return { story: draft, approved: true, review, rounds };
    }
  }
  await ctx.log('editor', `not approved after ${MAX_ROUNDS} rounds`);
  return { story: draft, approved: false, review, rounds };
}

module.exports = { runOutliner, writeAndEdit };
