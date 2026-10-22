import type { GenerateContentParameters } from '@google/genai';
import type { GeminiClient } from '../server/providers/gemini';

export interface FakeChunk {
  text?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    totalTokenCount?: number;
  };
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

export function geminiTextChunks(
  text: string,
  {
    chunkSize = 7,
    finishReason = 'STOP',
    usage = { prompt: 120, candidates: 80, cached: 0 },
  }: {
    chunkSize?: number;
    finishReason?: string;
    usage?: { prompt: number; candidates: number; cached: number };
  } = {},
): FakeChunk[] {
  const chunks: FakeChunk[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    const isLast = i + chunkSize >= text.length;
    chunks.push({
      text: text.slice(i, i + chunkSize),
      ...(isLast
        ? {
            candidates: [{ finishReason }],
            usageMetadata: {
              promptTokenCount: usage.prompt,
              candidatesTokenCount: usage.candidates,
              cachedContentTokenCount: usage.cached,
            },
          }
        : {}),
    });
  }
  return chunks;
}

export class FakeGemini implements GeminiClient {
  calls: Array<{ params: GenerateContentParameters; signal?: AbortSignal }> = [];
  aborted = 0;

  constructor(
    private scripts: Array<FakeChunk[] | Error | ((params: GenerateContentParameters) => FakeChunk[])>,
    private gate?: { after: number; until: Promise<void> },
  ) {}

  models = {
    generateContentStream: async (params: GenerateContentParameters, options?: { signal?: AbortSignal }) => {
      this.calls.push({ params, signal: options?.signal });
      const script = this.scripts.length > 1 ? this.scripts.shift()! : this.scripts[0];
      if (script instanceof Error) throw script;
      const chunks = typeof script === 'function' ? script(params) : script;
      const signal = options?.signal;
      const gate = this.gate;
      const self = this;

      return (async function* () {
        let sent = 0;
        for (const chunk of chunks) {
          if (signal?.aborted) {
            self.aborted++;
            return;
          }
          if (gate && sent === gate.after) await gate.until;
          if (signal?.aborted) {
            self.aborted++;
            return;
          }
          yield chunk as any;
          sent++;
        }
      })();
    },
  };
}
