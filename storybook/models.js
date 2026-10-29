// Every handoff contract between the /storybook agents. This file is the map of who hands what to whom.
const { z } = require('zod');

const Severity = z.enum(['must_fix', 'nice_to_have']);

// The person's request (validated by the API before anything is spent).
const BookRequest = z.object({
  subject: z.string().trim().min(2).max(120),
  age_group: z.enum(['2-4', '4-6', '6-8', '8-10']),
  story_type: z.string().trim().min(2).max(60),
  style: z.string().trim().min(2).max(80),
  page_count: z.number().int().min(4).max(12),
});

// Outliner -> Writer, Editor, Art Director (and you, at the first approval gate).
const BookOutline = z.object({
  needs_direction: z.string().nullable().describe(
    'Null when you can plan the book. If the request cannot become a good children\'s book as given ' +
    '(unsuitable subject for the age, contradictory instructions), ask the person one clear question here instead.'),
  title: z.string(),
  logline: z.string().describe('The whole story in one sentence'),
  theme: z.string().describe('The lesson or feeling the child should take away'),
  setting: z.string(),
  characters: z.array(z.object({
    name: z.string(),
    role: z.string().describe("Their part in the story, e.g. 'hero' or 'wise friend'"),
    appearance: z.string().describe('A precise visual description (species, colors, size, clothing, distinctive ' +
      'features) so an illustrator can draw them the same way on every page'),
  })),
  pages: z.array(z.object({
    page_number: z.number().int(),
    what_happens: z.string().describe('One or two sentences: the events on this page'),
    illustration_idea: z.string().describe('What the picture on this page should show'),
  })),
});

// Writer <-> Editor (and you, at the second approval gate).
const BookText = z.object({
  title: z.string(),
  pages: z.array(z.object({
    page_number: z.number().int(),
    text: z.string().describe('The words printed on this page, exactly as a child will read them'),
  })),
});

const EditorReview = z.object({
  strengths: z.array(z.string()).describe('What works well and must be kept in a revision'),
  issues: z.array(z.object({
    page_number: z.number().int().describe('The page with the problem, or 0 for the whole book'),
    severity: Severity,
    problem: z.string(),
    suggestion: z.string().describe('A concrete fix the writer can apply'),
  })),
});

// Art Director -> Illustrator <-> Art Reviewer.
const ArtPlan = z.object({
  art_style: z.string().describe('One paragraph describing the illustration style for the whole book: medium, ' +
    'color palette, line quality, lighting, mood'),
  character_sheet: z.string().describe('A scene showing every main character side by side on a plain background, ' +
    'full body, facing the viewer, so the illustrator can copy them exactly'),
  cover: z.string().describe('The scene for the front cover. No words or letters.'),
  pages: z.array(z.object({
    page_number: z.number().int(),
    scene: z.string().describe("What to draw: who is in the picture, what they're doing, where, camera angle and " +
      'mood. Refer to characters by name only; their looks are added for you.'),
  })),
});

const ImageReview = z.object({
  what_i_see: z.string().describe('Describe the picture first, before judging it'),
  issues: z.array(z.object({
    severity: Severity,
    problem: z.string(),
    fix_instruction: z.string().describe("An instruction for the illustrator, phrased as what TO draw"),
  })),
});

module.exports = { BookRequest, BookOutline, BookText, EditorReview, ArtPlan, ImageReview };
