import 'dotenv/config';
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { RateLimiter } from './rateLimit';

/** The proxy: holds the API key (never sent to the browser) and streams options as NDJSON. */

export const MAX_TOKENS_CAP = 4096;

const port = Number(process.env.PORT ?? 8787);
const perMinute = Number(process.env.RATE_LIMIT_PER_MIN ?? 20) || 20;
const maxTokens = Math.min(MAX_TOKENS_CAP, Number(process.env.MAX_TOKENS ?? 2048) || 2048);
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
const reference = readFileSync(new URL('../src/generated/strudel-reference.md', import.meta.url), 'utf8');

if (!apiKey) console.warn('[proxy] ANTHROPIC_API_KEY is not set: /api/options will answer with an auth error.');

const app = createApp({
  // maxRetries 1: a retry on 529/connection errors is worth one attempt, more just adds latency.
  claude: apiKey ? { client: new Anthropic({ apiKey, maxRetries: 1 }), reference, maxTokens } : null,
  limiter: new RateLimiter(perMinute),
});

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, ({ port }) =>
  console.log(`[proxy] listening on http://127.0.0.1:${port} (max_tokens ${maxTokens}, ${perMinute} calls/min)`),
);
