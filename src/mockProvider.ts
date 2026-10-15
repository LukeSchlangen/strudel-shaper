import type { Option, OptionRequest, Provider } from './provider';

type Tag = 'busier' | 'sparser';

interface Transform {
  suffix: string;
  label: string;
  tag?: Tag;
}

/** Real Strudel transforms, each checked against the transpiler in test/mockProvider.test.ts. */
export const TRANSFORMS: Transform[] = [
  { suffix: '.fast(2)', label: 'double time', tag: 'busier' },
  { suffix: '.ply(2)', label: 'stutter', tag: 'busier' },
  { suffix: '.off(1/8, x => x.gain(0.3))', label: 'echo', tag: 'busier' },
  { suffix: '.slow(2)', label: 'half time', tag: 'sparser' },
  { suffix: '.degradeBy(0.3)', label: 'sparser', tag: 'sparser' },
  { suffix: '.rev()', label: 'reversed' },
  { suffix: '.jux(rev)', label: 'stereo mirror' },
];

// Sparser is checked first so "less busy" reads as sparser.
const KEYWORDS: Array<[RegExp, Tag]> = [
  [/\b(sparser|calmer|sparse|calm|less)\b/i, 'sparser'],
  [/\b(busier|denser|busy|dense)\b/i, 'busier'],
];

const SHAPE_COUNT = 4;

/** mulberry32: small, fast, seedable. Returns floats in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Biased transforms first (shuffled), then the rest (shuffled). An empty instruction is a plain shuffle. */
export function pickTransforms(instruction: string, rand: () => number, count = SHAPE_COUNT): Transform[] {
  const tag = KEYWORDS.find(([re]) => re.test(instruction))?.[1];
  const biased = tag ? TRANSFORMS.filter((t) => t.tag === tag) : [];
  const rest = TRANSFORMS.filter((t) => !biased.includes(t));
  return [...shuffle(biased, rand), ...shuffle(rest, rand)].slice(0, count);
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Resolves after `ms`, or early (without rejecting) if the signal aborts. */
export const abortableSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });

export interface MockProviderOptions {
  seed: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  sleep?: Sleep;
}

export class MockProvider implements Provider {
  name = 'mock';
  private requestCount = 0;
  private readonly seed: number;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: Sleep;

  constructor({ seed, minDelayMs = 300, maxDelayMs = 1200, sleep = abortableSleep }: MockProviderOptions) {
    this.seed = seed;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.sleep = sleep;
  }

  /** Each call advances the seed, so regenerating with the same instruction gives a new set. */
  async *generateOptions(req: OptionRequest, signal: AbortSignal): AsyncGenerator<Option> {
    const requestSeed = this.seed + this.requestCount++;
    const rand = prng(requestSeed);
    const text = req.selection.text;
    // Append before any trailing whitespace or separator: `a,` + `.fast(2)` must become `a.fast(2),`.
    const tail = /[\s,;]*$/.exec(text)!;
    const append = (suffix: string) => text.slice(0, tail.index) + suffix + tail[0];
    const options: Option[] =
      req.mode === 'shape'
        ? pickTransforms(req.instruction, rand).map((t) => ({ id: '', label: t.label, code: append(t.suffix) }))
        : [{ id: '', label: 'mock fix', code: text }];

    for (const [i, option] of options.entries()) {
      const delay = this.minDelayMs + rand() * (this.maxDelayMs - this.minDelayMs);
      await this.sleep(delay, signal);
      if (signal.aborted) return;
      yield { ...option, id: `mock-${requestSeed}-${i}` };
    }
  }
}
