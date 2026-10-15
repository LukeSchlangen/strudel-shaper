import Anthropic from '@anthropic-ai/sdk';
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
  return { kind: 'internal', message: 'The proxy failed. See the server log.' };
}

/** The API's own message, without the SDK's status prefix or any JSON dump. */
function apiMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const msg = typeof body?.error?.message === 'string' ? body.error.message : err.message;
  return msg.replace(/^\d{3}\s+/, '').slice(0, 200);
}
