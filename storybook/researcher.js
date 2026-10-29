// The Researcher: the one true looping agent. It searches the web, saves facts with a tool we run,
// and can stop to ask the person for direction when the subject doesn't work for a children's book.
const { MODELS, claude, addClaudeCost, NeedsDirection } = require('./common');

const MAX_TURNS = 15;
const MIN_FACTS = 5;

const TOOLS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 6 },
  {
    name: 'save_fact',
    description: 'Save one fact about the subject to the research notes for the book. Call this once per fact, ' +
      'only for facts you found in a reliable source.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The fact, stated accurately' },
        kid_friendly: { type: 'string', description: "The same fact, rewritten for the reader's age group" },
        category: { type: 'string', enum: ['appearance', 'behavior', 'habitat', 'food', 'history', 'amazing'] },
        source_url: { type: 'string' },
      },
      required: ['fact', 'kid_friendly', 'category', 'source_url'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_for_direction',
    description: 'Stop and ask the person making the book a question. Use this only when you cannot do the job ' +
      'well as asked: the subject is unclear (several very different meanings), unsuitable for young children, ' +
      'or you cannot find reliable information about it.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string', description: 'One clear question, with the options if there are any' } },
      required: ['question'],
      additionalProperties: false,
    },
  },
];

const SYSTEM = `You are a fact researcher for a children's picture book.

Your job: find 8 to 12 true, surprising, kid-pleasing facts about the subject,
so the author can weave real facts into the story.

How to work:
- Use web_search to find information. Prefer reliable sources (museums, zoos,
  universities, encyclopedias, government science agencies).
- Call save_fact once for each fact worth keeping. Cover several categories.
- Every fact must be different from the ones you've already saved.
- Skip anything frightening or gory for the reader's age group.
- If you can't do this well as asked, call ask_for_direction instead of guessing.
- When you have enough facts, stop calling tools and reply with a one-sentence summary.`;

function similarity(a, b) {
  // Share of words in common: a cheap, certain duplicate check that needs no AI.
  const wa = new Set(a.toLowerCase().match(/[a-z0-9]+/g) || []);
  const wb = new Set(b.toLowerCase().match(/[a-z0-9]+/g) || []);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / Math.max(1, Math.min(wa.size, wb.size));
}

async function runResearcher(ctx, request, guidance) {
  const facts = [];
  const model = MODELS.researcher;
  let userText = `Subject: ${request.subject}\nReader age group: ${request.age_group}`;
  if (guidance) userText += `\n\nDIRECTION FROM THE PERSON MAKING THE BOOK:\n${guidance}`;
  const messages = [{ role: 'user', content: userText }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await claude().beta.messages.create({
      model, max_tokens: 16000, system: SYSTEM, tools: TOOLS, messages,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    });
    addClaudeCost(ctx, 'researcher', model, response.usage);
    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'server_tool_use' && block.name === 'web_search') await ctx.log('researcher', `search: ${block.input.query}`);
    }

    if (response.stop_reason === 'end_turn') break;
    if (response.stop_reason === 'pause_turn') continue;
    if (response.stop_reason === 'refusal') throw new NeedsDirection('The researcher declined this subject. Try a different subject or explain what you have in mind.');
    if (response.stop_reason !== 'tool_use') throw new Error(`researcher: unexpected stop_reason ${response.stop_reason}`);

    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'ask_for_direction') {
        await ctx.log('researcher', 'stopped to ask for direction');
        throw new NeedsDirection(block.input.question, { facts_so_far: facts.length });
      }
      if (facts.some((f) => similarity(f.fact, block.input.fact) > 0.7)) {
        await ctx.log('researcher', 'rejected a duplicate fact');
        results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true,
          content: 'Not saved: too similar to a fact already in the notes. Find a different one.' });
        continue;
      }
      facts.push(block.input);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: `Saved fact #${facts.length} (${block.input.category}).` });
    }
    messages.push({ role: 'user', content: results });
  }

  await ctx.log('researcher', `done with ${facts.length} facts`);
  // A rule, not a judgment call: too few facts means the person should decide what to do.
  if (facts.length < MIN_FACTS) {
    throw new NeedsDirection(`The researcher only found ${facts.length} reliable facts about "${request.subject}". ` +
      'Give it more direction (a narrower or clearer subject), or continue anyway with what it found.',
    { allow_continue: true, partial: { subject: request.subject, facts } });
  }
  return { subject: request.subject, facts };
}

module.exports = { runResearcher };
