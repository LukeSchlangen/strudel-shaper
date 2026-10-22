import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { RateLimiter } from './rateLimit';

/** The proxy: holds API keys (never sent to the browser) and streams options as NDJSON. */

export const MAX_TOKENS_CAP = 4096;

const isProd = process.env.NODE_ENV === 'production';
const host = process.env.HOST ?? (isProd ? '0.0.0.0' : '127.0.0.1');
const port = Number(process.env.PORT ?? (isProd ? 8080 : 8787));
const perMinute = Number(process.env.RATE_LIMIT_PER_MIN ?? 20) || 20;
const maxTokens = Math.min(MAX_TOKENS_CAP, Number(process.env.MAX_TOKENS ?? 2048) || 2048);
const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
const geminiApiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)?.trim();
const reference = readFileSync(new URL('../src/generated/strudel-reference.md', import.meta.url), 'utf8');

if (!anthropicApiKey) console.warn('[proxy] ANTHROPIC_API_KEY is not set: Claude models will be disabled.');
if (!geminiApiKey) console.warn('[proxy] GEMINI_API_KEY is not set: Gemini models will be disabled.');

const app = createApp({
  // maxRetries 1: a retry on 529/connection errors is worth one attempt, more just adds latency.
  claude: anthropicApiKey ? { client: new Anthropic({ apiKey: anthropicApiKey, maxRetries: 1 }), reference, maxTokens } : null,
  gemini: geminiApiKey ? { client: new GoogleGenAI({ apiKey: geminiApiKey }), reference, maxTokens } : null,
  limiter: new RateLimiter(perMinute),
});

// In production or when dist/ exists, serve static assets and SPA fallback
if (existsSync('./dist')) {
  app.use('/assets/*', serveStatic({ root: './dist' }));
  app.get('/*', serveStatic({ path: './dist/index.html' }));
}

serve({ fetch: app.fetch, port, hostname: host }, ({ port }) =>
  console.log(`[proxy] listening on http://${host}:${port} (max_tokens ${maxTokens}, ${perMinute} calls/min)`),
);
