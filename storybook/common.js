// Shared plumbing for the /storybook agents: API clients, the model for each agent,
// one helper for structured Claude calls, cost math, and the "a human needs to decide" signal.
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const { z } = require('zod');

// Which model each step uses. The flowchart page (web/how-it-works.html) shows this same table.
const MODELS = {
  researcher: 'claude-opus-5-5',
  outliner: 'claude-opus-5-5',
  writer: 'claude-opus-5-5',
  editor: 'claude-opus-5-5',
  art_director: 'claude-opus-5-5',
  art_reviewer: 'claude-haiku-5-5', // looks at ~20 pictures per book, so the cheap model saves the most here
  illustrator: 'gemini-3.1-flash-lite-image',
};

// US dollars, checked October 2026. Claude prices are per million tokens.
const PRICES = {
  'claude-opus-5-5': { input: 4.0, output: 20.0 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};
const PRICE_WEB_SEARCH = 0.01;
const PRICE_IMAGE = 0.0336;

let anthropic = null;
let gemini = null;
// Created on first use: server.js loads .env files after requiring this module.
const claude = () => (anthropic ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
const imageClient = () => {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured.');
  return (gemini ||= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));
};

// Raised by any step that needs a person: an agent asked for direction, a review loop
// ran out of retries, or a model declined. The pipeline turns it into a "needs you" state.
class NeedsDirection extends Error {
  constructor(question, details = {}) {
    super(question);
    this.question = question;
    this.details = details;
  }
}

// Turn a zod schema into the JSON schema the API's structured outputs accept.
function jsonSchema(schema) {
  const out = z.toJSONSchema(schema);
  delete out.$schema;
  (function strip(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'integer') { delete node.minimum; delete node.maximum; }
    Object.values(node).forEach(strip);
  })(out);
  return out;
}

function addClaudeCost(ctx, agent, model, usage) {
  const price = PRICES[model];
  const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  const cost = (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1e6 + searches * PRICE_WEB_SEARCH;
  ctx.costs[agent] = (ctx.costs[agent] || 0) + cost;
}

function addImageCost(ctx) {
  ctx.costs.illustrator = (ctx.costs.illustrator || 0) + PRICE_IMAGE;
}

// Opus models get server-side refusal fallbacks; Haiku doesn't support them.
function requestFor(model, params) {
  if (model.startsWith('claude-haiku')) return claude().messages.create({ model, ...params });
  return claude().beta.messages.create({ model, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', ...params });
}

// One Claude call that must return an object matching `schema` (a zod schema).
async function ask(ctx, agent, { system, content, schema }) {
  const model = MODELS[agent];
  const message = await requestFor(model, {
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema: jsonSchema(schema) } },
  });
  addClaudeCost(ctx, agent, model, message.usage);
  if (message.stop_reason === 'refusal') {
    throw new NeedsDirection(`The ${agent.replace('_', ' ')} declined this request. Try rewording the subject or giving it more direction.`);
  }
  if (message.stop_reason !== 'end_turn') throw new Error(`${agent}: no usable answer (stop_reason=${message.stop_reason})`);
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return schema.parse(JSON.parse(text));
}

// Run async jobs with at most `limit` running at once.
async function inParallel(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = { MODELS, PRICE_WEB_SEARCH, claude, imageClient, ask, addClaudeCost, addImageCost, NeedsDirection, inParallel };
