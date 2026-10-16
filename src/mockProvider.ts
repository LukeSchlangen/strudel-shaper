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

/** The kinds of broken option the mock can produce (see `faultRate`). */
export type FaultKind = 'syntax' | 'unknown-function' | 'unknown-sample' | 'runtime' | 'empty' | 'identical' | 'duplicate';
export const FAULT_KINDS: FaultKind[] = ['syntax', 'unknown-function', 'unknown-sample', 'runtime', 'empty', 'identical', 'duplicate'];

/** Fix modes return a musical no-op: the unchanged selection would be dropped as identical. */
const FIX_CANDIDATES: Transform[] = [
  { suffix: '.fast(1)', label: 'mock fix (no-op)' },
  { suffix: '.slow(1)', label: 'mock fix (no-op)' },
];

export interface MockProviderOptions {
  seed: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  sleep?: Sleep;
  /** Chance (0–1) that an option is replaced by a broken one. */
  faultRate?: number;
  /** Seed for the fault stream; defaults to `seed`. Faults never consume the option/delay stream. */
  faultSeed?: number;
  /** Always produce this kind of fault (when one triggers) instead of a seeded pick. */
  faultKind?: FaultKind;
  /** Replacements asked for with `feedback` are broken again, to exercise the permanent-drop path. */
  retryFails?: boolean;
}

export interface FaultLogEntry {
  optionId: string;
  kind: FaultKind;
  code: string;
}

export class MockProvider implements Provider {
  name = 'mock';
  faultRate: number;
  faultKind: FaultKind | undefined;
  retryFails: boolean;
  /** Every fault produced, for tests and the soak harness. */
  readonly faultLog: FaultLogEntry[] = [];
  private requestCount = 0;
  private readonly seed: number;
  private readonly faultSeed: number;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: Sleep;
  /**
   * Codes planned or issued since the last full request, so replacements don't repeat them. Planned
   * counts too: a replacement can be asked for before the rest of the stream has been yielded.
   */
  private taken = new Set<string>();

  constructor({
    seed,
    minDelayMs = 300,
    maxDelayMs = 1200,
    sleep = abortableSleep,
    faultRate = 0,
    faultSeed = seed,
    faultKind,
    retryFails = false,
  }: MockProviderOptions) {
    this.seed = seed;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.sleep = sleep;
    this.faultRate = faultRate;
    this.faultSeed = faultSeed;
    this.faultKind = faultKind;
    this.retryFails = retryFails;
  }

  /** Each call advances the seed, so regenerating with the same instruction gives a new set. */
  async *generateOptions(req: OptionRequest, signal: AbortSignal): AsyncGenerator<Option> {
    const count = this.requestCount++;
    const requestSeed = this.seed + count;
    const rand = prng(requestSeed);
    // A separate stream, so faultRate 0 gives exactly the options and delays of milestone 2.
    const faultRand = prng((this.faultSeed + count) ^ 0x9e3779b9);
    const text = req.selection.text;
    // Append before any trailing whitespace or separator: `a,` + `.fast(2)` must become `a.fast(2),`.
    const tail = /[\s,;]*$/.exec(text)!;
    const body = text.slice(0, tail.index);
    const append = (suffix: string) => body + suffix + tail[0];
    const delay = () => this.minDelayMs + rand() * (this.maxDelayMs - this.minDelayMs);
    const clean: Option[] = [];

    const fault = (kind: FaultKind): Omit<Option, 'id'> | null => {
      switch (kind) {
        case 'syntax':
          // An unclosed paren, or drop the closing quote of the first string.
          if (faultRand() < 0.5 || !/"[^"]*"/.test(body)) return { label: 'unclosed paren', code: append('.fast(2') };
          return { label: 'unclosed quote', code: body.replace(/"([^"]*)"/, '"$1') + tail[0] };
        case 'unknown-function':
          return { label: 'wobble', code: append('.wobble(2)') };
        case 'unknown-sample':
          return { label: 'zzzz', code: 's("zzzz*4")' + tail[0] };
        case 'runtime':
          // Transpiles and evaluates; throws only when queried (no event has a velocity).
          return { label: 'velocity', code: append('.fmap(v => v.velocity.toFixed(2))') };
        case 'empty':
          return { label: 'silent', code: append('.degradeBy(1)') };
        case 'identical':
          return { label: 'same again', code: spaced(body) + tail[0] };
        case 'duplicate': {
          // Copy an earlier clean option: a copy of a broken one would be dropped for its own fault.
          const earlier = clean.at(-1);
          return earlier ? { label: `${earlier.label} again`, code: spaced(earlier.code) } : null;
        }
      }
    };
    const maybeFault = (option: Omit<Option, 'id'>, forced?: FaultKind): [Omit<Option, 'id'>, FaultKind?] => {
      if (!forced && !(faultRand() < this.faultRate)) return [option];
      let kind = forced ?? this.faultKind ?? FAULT_KINDS[Math.floor(faultRand() * FAULT_KINDS.length)];
      let broken = fault(kind);
      if (!broken) {
        // Nothing to duplicate yet: use the next kind instead.
        kind = FAULT_KINDS[(FAULT_KINDS.indexOf(kind) + 1) % FAULT_KINDS.length];
        broken = fault(kind)!;
      }
      return [broken, kind];
    };

    let planned: Array<Omit<Option, 'id'>>;
    if (req.feedback) {
      // A replacement for one failed option: one option, valid unless retryFails.
      const candidates = req.mode === 'shape' ? shuffle(TRANSFORMS, rand) : FIX_CANDIDATES;
      const fresh = candidates.find((t) => !this.taken.has(append(t.suffix))) ?? candidates[0];
      const balanced = req.mode === 'fix-minimal' ? naiveBalance(body) : body;
      planned = [balanced !== body && !this.taken.has(balanced + tail[0]) ? { label: 'mock fix', code: balanced + tail[0] } : { label: fresh.label, code: append(fresh.suffix) }];
      this.taken.add(planned[0].code); // now, since several replacements can be pending at once
    } else {
      planned =
        req.mode === 'shape'
          ? pickTransforms(req.instruction, rand).map((t) => ({ label: t.label, code: append(t.suffix) }))
          : req.mode === 'fix-minimal' && naiveBalance(body) !== body
            ? [{ label: 'mock fix', code: naiveBalance(body) + tail[0] }]
            : [{ label: FIX_CANDIDATES[0].label, code: append(FIX_CANDIDATES[0].suffix) }];
      this.taken = new Set(planned.map((p) => p.code));
    }

    for (const [i, plan] of planned.entries()) {
      const wait = delay();
      // A replacement is valid unless retryFails; otherwise each option faults with probability faultRate.
      const [chosen, kind] = req.feedback ? (this.retryFails ? maybeFault(plan, this.faultKind ?? 'syntax') : [plan]) : maybeFault(plan);
      await this.sleep(wait, signal);
      if (signal.aborted) return;
      const option = { ...chosen, id: `mock-${requestSeed}-${i}` };
      if (kind) this.faultLog.push({ optionId: option.id, kind, code: option.code });
      this.taken.add(option.code);
      if (!kind) clean.push(option);
      yield option;
    }
  }
}

/**
 * The mock's minimal fix, for offline demos: close a string left open (before the next `)`), drop
 * or close unbalanced mini-notation brackets inside strings, then close parens left open. Anything
 * else (a misspelled name, a wrong argument) it can't fix, and returns the code unchanged.
 */
export function naiveBalance(code: string): string {
  let out = code;
  if ((out.match(/"/g) ?? []).length % 2 === 1) {
    const open = out.lastIndexOf('"');
    const close = out.indexOf(')', open);
    out = close < 0 ? out + '"' : out.slice(0, close) + '"' + out.slice(close);
  }
  out = out.replace(/"([^"]*)"/g, (_m, inner: string) => {
    const missing = closers(inner, '[<{', ']>}');
    // A stray opener at the very end ("hh*8[") was most likely typed by accident: drop it.
    if (missing.length === 1 && /[[<{]$/.test(inner)) return `"${inner.slice(0, -1)}"`;
    return `"${inner}${missing}"`;
  });
  return out + closers(out.replace(/"[^"]*"/g, '""'), '([', ')]');
}

/** The closing brackets `s` is missing, innermost first. Extra closers are ignored. */
function closers(s: string, opens: string, closes: string): string {
  const stack: string[] = [];
  for (const c of s) {
    const o = opens.indexOf(c);
    if (o >= 0) stack.push(closes[o]);
    else if (closes.includes(c) && stack.at(-1) === c) stack.pop();
  }
  return stack.reverse().join('');
}

/** The same code with harmless extra whitespace, which the validator's normalization must see through. */
function spaced(code: string): string {
  return code.includes('(') ? code.replace('(', '( ') : ` ${code}`;
}
