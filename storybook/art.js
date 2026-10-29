// The Art Director (Claude), the Illustrator (Gemini, plain code: no decisions) and the
// Art Reviewer (Claude Haiku, looks at every picture). Pictures after the character sheet
// don't depend on each other, so they are drawn and reviewed in parallel.
const store = require('./store');
const { MODELS, ask, imageClient, addImageCost, inParallel } = require('./common');
const { ArtPlan, ImageReview } = require('./models');

const MAX_REDRAWS = 2;
const PARALLEL_PICTURES = 4;

const DIRECTOR_SYSTEM = `You are the art director for a children's picture book. You don't draw; you
write precise instructions for an illustrator who has never read the book.

- Choose one art style that suits the story, the age group and the tone, and
  describe it concretely enough that every page will look like the same book.
- For each page, describe a single clear moment from that page's text: who is
  in it, what they are doing, the setting, the framing (close-up, wide shot)
  and the mood. Vary the framing across the book so it stays lively.
- Only include characters who are actually present on that page of the story.
- Leave room in each picture for the page's words (for example "keep the top
  third of the image as open sky").
- Never ask for any written words, letters, numbers or sound effects in the pictures.`;

const REVIEWER_SYSTEM = `You are the art reviewer for a children's picture book. You compare a new
illustration to the book's character sheet and to the story.

Check:
1. Characters: each one looks like the character sheet (species, colors,
   accessories, proportions). Story events can change them on purpose (a hat
   that was lost, a character who is wet or asleep): read the story before
   flagging a difference. Only characters who are in that part of the story
   should appear.
2. Scene: the picture shows what the art direction asks for on this page.
3. No text: there must be no letters, words, numbers or signs with writing.
4. Quality: no anatomy errors (merged bodies, extra heads), nothing
   frightening for a young child.
5. Direction: anything the person making the book asked for is done.

Severity:
- must_fix: a parent would notice, or a child would be confused.
- nice_to_have: small polish. Exact counts of legs, bees or other small things,
  and details of pose or expression that don't contradict the story, are
  nice_to_have. Don't invent problems; an empty list is a fine answer.`;

async function runArtDirector(ctx, request, story, outline) {
  await ctx.log('art_director', 'choosing a style and planning every picture');
  const content = `Age group: ${request.age_group}\nStyle: ${request.style}\nStory type: ${request.story_type}\n\n` +
    `OUTLINE (includes the characters' appearance):\n${JSON.stringify(outline, null, 2)}\n\nFINAL TEXT:\n${JSON.stringify(story, null, 2)}`;
  return ask(ctx, 'art_director', { system: DIRECTOR_SYSTEM, content, schema: ArtPlan });
}

// Every prompt gets the same style and cast text, glued on by code: that repetition keeps characters consistent.
function buildPrompt(scene, plan, outline, corrections = []) {
  const cast = outline.characters.map((c) => `- ${c.name}: ${c.appearance}`).join('\n');
  let prompt = `A children's picture book illustration.\n\nSTYLE: ${plan.art_style}\n\n` +
    `CHARACTERS (draw them exactly like this, and like the reference image if one is given):\n${cast}\n\n` +
    `SCENE: ${scene}\n\nDo not include any text, letters, numbers, sound effects or speech bubbles.`;
  if (corrections.length) prompt += `\n\nCORRECTIONS (must follow):\n${corrections.map((c) => `- ${c}`).join('\n')}`;
  return prompt;
}

async function draw(ctx, prompt, reference) {
  const parts = [{ text: prompt }];
  if (reference) parts.unshift({ inlineData: { mimeType: 'image/jpeg', data: reference.toString('base64') } });
  const response = await imageClient().models.generateContent({
    model: MODELS.illustrator,
    contents: [{ role: 'user', parts }],
    config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:3' } },
  });
  addImageCost(ctx);
  const part = (response.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData);
  if (!part) throw new Error('The illustrator returned no picture (it may have been blocked by its safety filter).');
  return Buffer.from(part.inlineData.data, 'base64');
}

const imageBlock = (bytes) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: bytes.toString('base64') } });

async function reviewPicture(ctx, image, sheet, job, story) {
  const storyText = story.pages.map((p) => `Page ${p.page_number}: ${p.text}`).join('\n');
  let direction = `ART DIRECTION for this picture:\n${job.scene}\n\nTHE WHOLE STORY (for continuity):\n${storyText}`;
  if (job.humanNotes) direction += `\n\nTHE PERSON MAKING THE BOOK ASKED FOR:\n${job.humanNotes}`;
  return ask(ctx, 'art_reviewer', {
    system: REVIEWER_SYSTEM,
    schema: ImageReview,
    content: [
      { type: 'text', text: 'CHARACTER SHEET (the reference):' }, imageBlock(sheet),
      { type: 'text', text: `NEW ILLUSTRATION to review (${job.label}):` }, imageBlock(image),
      { type: 'text', text: direction },
    ],
  });
}

// Draw (if needed), review, redraw with the reviewer's notes, up to MAX_REDRAWS. Never throws:
// a picture that can't be fixed is returned as "flagged" so a person can decide.
async function makePicture(ctx, bookId, job, plan, outline, story, sheet, state) {
  const corrections = state.human_notes ? [state.human_notes] : [];
  try {
    let image = state.redraw ? null : await store.getImage(bookId, job.name);
    if (!image) {
      await ctx.log('illustrator', `drawing ${job.label}`);
      image = await draw(ctx, buildPrompt(job.scene, plan, outline, corrections), sheet);
      await store.putImage(bookId, job.name, image);
    }
    for (let attempt = 1; ; attempt++) {
      const review = await reviewPicture(ctx, image, sheet, { ...job, humanNotes: state.human_notes }, story);
      const mustFix = review.issues.filter((i) => i.severity === 'must_fix');
      if (!mustFix.length) {
        await ctx.log('art_reviewer', `${job.label}: approved`);
        return { status: 'approved', issues: [] };
      }
      if (attempt > MAX_REDRAWS) {
        await ctx.log('art_reviewer', `${job.label}: still has problems, needs your eyes`);
        return { status: 'flagged', issues: mustFix.map((i) => i.problem) };
      }
      await ctx.log('art_reviewer', `${job.label}: ${mustFix[0].problem.slice(0, 90)}`);
      corrections.push(...mustFix.map((i) => i.fix_instruction));
      await ctx.log('illustrator', `redrawing ${job.label}`);
      image = await draw(ctx, buildPrompt(job.scene, plan, outline, corrections), sheet);
      await store.putImage(bookId, job.name, image);
    }
  } catch (err) {
    await ctx.log('illustrator', `${job.label}: ${err.message}`);
    return { status: 'flagged', issues: [err.message] };
  }
}

function pictureJobs(plan) {
  return [{ name: 'cover', label: 'cover', scene: plan.cover }].concat(plan.pages.map((p) => ({
    name: `page_${String(p.page_number).padStart(2, '0')}`, label: `page ${p.page_number}`, scene: p.scene,
  })));
}

// Draws and reviews every picture that isn't approved or accepted yet. `pictures` is the saved
// state per picture ({ status, issues, human_notes, redraw }) and is updated in place.
async function illustrate(ctx, bookId, plan, outline, story, pictures, save) {
  let sheet = await store.getImage(bookId, 'characters');
  if (!sheet) {
    await ctx.log('illustrator', 'drawing the character sheet');
    sheet = await draw(ctx, buildPrompt(plan.character_sheet, plan, outline), null);
    await store.putImage(bookId, 'characters', sheet);
  }

  const todo = pictureJobs(plan).filter((job) => !['approved', 'accepted'].includes(pictures[job.name]?.status));
  await inParallel(todo, PARALLEL_PICTURES, async (job) => {
    const result = await makePicture(ctx, bookId, job, plan, outline, story, sheet, pictures[job.name] || {});
    pictures[job.name] = { ...result, human_notes: pictures[job.name]?.human_notes || '' };
    await save(); // checkpoint after each picture, so a crash never loses finished work
  });
  return pictureJobs(plan).filter((job) => pictures[job.name]?.status === 'flagged').map((job) => job.name);
}

module.exports = { runArtDirector, illustrate, pictureJobs };
