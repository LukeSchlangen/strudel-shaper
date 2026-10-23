import Anthropic from '@anthropic-ai/sdk';
import { ApiError } from '@google/genai';
import type { ErrorKind } from '../src/remoteProtocol';

export interface MappedError {
  kind: ErrorKind;
  /** Short, safe to show in the status line. Never a stack trace. */
  message: string;
}

/** Turns anything thrown by the SDK (or our own code) into a status-line message. */
export function mapError(err: unknown): MappedError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return { kind: 'auth', message: 'The API key was rejected. Check ANTHROPIC_API_KEY in .env.' };
  }
  if (err instanceof Anthropic.RateLimitError) {
    const after = err.headers?.get?.('retry-after');
    return { kind: 'rate-limit', message: `Anthropic rate limit reached${after ? `; retry in ${after} s` : ''}.` };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { kind: 'network', message: 'Could not reach the Anthropic API.' };
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 529) return { kind: 'overloaded', message: 'The API is overloaded. Try again in a moment.' };
    if (err.status === 400 || err.status === 404 || err.status === 422) {
      return { kind: 'bad-request', message: `The API rejected the request: ${apiMessage(err)}` };
    }
    return { kind: 'internal', message: `API error ${err.status ?? ''}: ${apiMessage(err)}`.trim() };
  }

  if (err instanceof ApiError) {
    const rawMsg = err.message || '';
    let msg = rawMsg;
    try {
      const parsed = JSON.parse(rawMsg);
      if (parsed.error?.message) {
        msg = parsed.error.message;
      }
    } catch {}

    if (err.status === 401 || err.status === 403 || msg.includes('API_KEY_INVALID') || msg.includes('API key not valid')) {
      return { kind: 'auth', message: 'The API key was rejected. Check GEMINI_API_KEY in .env.' };
    }
    if (err.status === 429 || msg.includes('RESOURCE_EXHAUSTED')) {
      return { kind: 'rate-limit', message: 'Gemini rate limit reached. Wait a moment.' };
    }
    if (err.status === 503 || msg.includes('UNAVAILABLE')) {
      return { kind: 'overloaded', message: 'The Gemini API is overloaded. Try again in a moment.' };
    }
    if (err.status === 400 || err.status === 404) {
      return { kind: 'bad-request', message: `The Gemini API rejected the request: ${msg.slice(0, 200)}` };
    }
    return { kind: 'internal', message: `Gemini API error ${err.status ?? ''}: ${msg.slice(0, 200)}`.trim() };
  }

  if (err instanceof Error) {
    const msg = err.message || '';
    if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || err.name === 'FetchError') {
      return { kind: 'network', message: 'Could not reach the API upstream.' };
    }
    if (msg.includes('API_KEY_INVALID') || msg.includes('API key not valid')) {
      return { kind: 'auth', message: 'The API key was rejected. Check your API key in .env.' };
    }
  }

  return { kind: 'internal', message: 'The proxy failed. See the server log.' };
}

/** The API's own message, without the SDK's status prefix or any JSON dump. */
function apiMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const msg = typeof body?.error?.message === 'string' ? body.error.message : err.message;
  return msg.replace(/^\d{3}\s+/, '').slice(0, 200);
}
