import { describe, expect, it } from 'vitest';
import { createApp, isAuthorizedKey, MAX_BUFFER_CHARS, MAX_INSTRUCTION_CHARS, MAX_PAYLOAD_BYTES, MAX_SELECTION_CHARS, MAX_SOUNDS_CHARS } from '../server/app';
import { cleanOption, MAX_OPTION_CHARS } from '../server/providers/postprocess';
import { buildGeminiParams } from '../server/providers/gemini';
import { buildParams } from '../server/providers/claude';
import { RateLimiter } from '../server/rateLimit';
import { FakeGemini, geminiTextChunks } from './fakeGemini';
import { FakeMessages } from './fakeAnthropic';
import type { RemoteRequest } from '../src/remoteProtocol';

const baseReq: RemoteRequest = {
  provider: 'gemini',
  model: 'gemini-3.8-flash',
  mode: 'shape',
  buffer: 's("bd*4")',
  selection: { from: 0, to: 9, text: 's("bd*4")' },
  instruction: '',
  cps: 0.5,
};

describe('RateLimiter abuse prevention', () => {
  it('enforces both per-IP and global limits', () => {
    let now = 1000;
    // 5 per minute global, 2 per minute per IP
    const limiter = new RateLimiter(5, 2, () => now);

    // IP 1 uses its 2 slots
    expect(limiter.take('1.1.1.1')).toBe(true);
    expect(limiter.take('1.1.1.1')).toBe(true);
    // IP 1 is now rate-limited
    expect(limiter.take('1.1.1.1')).toBe(false);

    // IP 2 can still make calls
    expect(limiter.take('2.2.2.2')).toBe(true);
    expect(limiter.take('2.2.2.2')).toBe(true);
    expect(limiter.take('2.2.2.2')).toBe(false);

    // IP 3 can make 1 call to reach global limit of 5
    expect(limiter.take('3.3.3.3')).toBe(true);
    // Now global limit is reached
    expect(limiter.take('3.3.3.3')).toBe(false);
    expect(limiter.take('4.4.4.4')).toBe(false);

    // After 60 seconds, window slides
    now += 60_001;
    expect(limiter.take('1.1.1.1')).toBe(true);
  });
});

describe('Input size limits in createApp', () => {
  const app = createApp({
    claude: null,
    gemini: { client: new FakeGemini([]), reference: 'REF', maxTokens: 1024 },
    limiter: new RateLimiter(100, 100),
  });

  it('rejects oversized buffer', async () => {
    const res = await app.request('/api/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseReq, buffer: 'x'.repeat(MAX_BUFFER_CHARS + 1) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Buffer exceeds');
  });

  it('rejects oversized selection', async () => {
    const bigSel = 's'.repeat(MAX_SELECTION_CHARS + 1);
    const res = await app.request('/api/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseReq, buffer: bigSel, selection: { from: 0, to: bigSel.length, text: bigSel } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Selection exceeds');
  });

  it('rejects oversized instruction', async () => {
    const res = await app.request('/api/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseReq, instruction: 'i'.repeat(MAX_INSTRUCTION_CHARS + 1) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Instruction exceeds');
  });

  it('rejects oversized sounds summary', async () => {
    const res = await app.request('/api/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseReq, sounds: 's'.repeat(MAX_SOUNDS_CHARS + 1) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Sounds summary exceeds');
  });

  it('accepts legitimate prebaked sounds summary (~4.2k chars)', async () => {
    const res = await app.request('/api/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseReq, sounds: 's'.repeat(4500) }),
    });
    expect(res.status).not.toBe(400);
  });

  it('rejects payload exceeding MAX_PAYLOAD_BYTES', async () => {
    const res = await app.request('/api/options', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(MAX_PAYLOAD_BYTES + 10),
      },
      body: JSON.stringify(baseReq),
    });
    expect(res.status).toBe(413);
  });

  it('blocks unauthorized cross-origin requests', async () => {
    const res = await app.request('/api/options', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://malicious-site.com',
        host: 'strudel-shaper.app',
      },
      body: JSON.stringify(baseReq),
    });
    expect(res.status).toBe(403);
  });
});

describe('Response token and size bounds', () => {
  it('caps max output tokens tightly for single-option requests', () => {
    const depsClaude = { client: new FakeMessages([]), reference: 'REF', maxTokens: 1024 };
    const pClaudeSingle = buildParams(depsClaude, baseReq, { single: true });
    expect(pClaudeSingle.max_tokens).toBeLessThanOrEqual(400);

    const depsGemini = { client: new FakeGemini([]), reference: 'REF', maxTokens: 1024 };
    const pGeminiSingle = buildGeminiParams(depsGemini, baseReq, { single: true });
    expect(pGeminiSingle.config?.maxOutputTokens).toBeLessThanOrEqual(400);
  });

  it('rejects bloated option code output', () => {
    const normal = cleanOption({ label: 'test', code: 's("bd*4")' });
    expect(normal).not.toBeNull();

    const bloated = cleanOption({ label: 'test', code: 's("bd").repeat(999).' + 'x'.repeat(MAX_OPTION_CHARS) });
    expect(bloated).toBeNull();
  });
});

describe('Site access key authentication', () => {
  it('validates timing-safe key equality', () => {
    expect(isAuthorizedKey(null, undefined)).toBe(true);
    expect(isAuthorizedKey(undefined, 'anything')).toBe(true);
    expect(isAuthorizedKey('secret123', undefined)).toBe(false);
    expect(isAuthorizedKey('secret123', 'wrong')).toBe(false);
    expect(isAuthorizedKey('secret123', 'secret1234')).toBe(false);
    expect(isAuthorizedKey('secret123', 'secret123')).toBe(true);
  });

  const protectedApp = createApp({
    claude: null,
    gemini: { client: new FakeGemini([geminiTextChunks('```strudel\ns("hh*4")\n```')]), reference: 'REF', maxTokens: 1024 },
    accessKey: 'shaper-secure-pwd',
    limiter: new RateLimiter(100, 100),
  });

  it('reports requiresAccessKey in /api/models', async () => {
    const res = await protectedApp.request('/api/models');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.requiresAccessKey).toBe(true);
  });

  it('rejects /api/options without access key', async () => {
    const res = await protectedApp.request('/api/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseReq),
    });
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.kind).toBe('auth');
    expect(data.message).toContain('access key');
  });

  it('rejects /api/options with invalid access key', async () => {
    const res = await protectedApp.request('/api/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-access-key': 'wrong-password' },
      body: JSON.stringify(baseReq),
    });
    expect(res.status).toBe(401);
  });

  it('allows /api/options with matching x-access-key header', async () => {
    const res = await protectedApp.request('/api/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-access-key': 'shaper-secure-pwd' },
      body: JSON.stringify(baseReq),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
  });

  it('allows /api/options with matching Bearer token', async () => {
    const res = await protectedApp.request('/api/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer shaper-secure-pwd' },
      body: JSON.stringify(baseReq),
    });
    expect(res.status).toBe(200);
  });

  it('enforces access key on /api/warmup', async () => {
    const denied = await protectedApp.request('/api/warmup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.8-flash' }),
    });
    expect(denied.status).toBe(401);

    const allowed = await protectedApp.request('/api/warmup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-access-key': 'shaper-secure-pwd' },
      body: JSON.stringify({ model: 'gemini-3.8-flash' }),
    });
    expect(allowed.status).toBe(200);
  });
});
