import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import { transpiler } from '@strudel/transpiler';

/**
 * Evaluates and queries Strudel code with a private, never-started repl. In the browser this runs
 * inside a Web Worker (src/validator.worker.ts), a separate realm with its own globals and
 * Pattern.prototype, so nothing here can reach the live scheduler, soundMap or editor.
 * Tests run it in-process, where it overwrites this realm's Strudel globals: test-only.
 */

export type CheckStage = 'syntax' | 'eval' | 'query' | 'timeout';

export type CheckResult =
  | { ok: false; stage: CheckStage; message: string; ms: number }
  | { ok: true; eventCount: number; sounds: string[]; ms: number };

/** Names from the live scope that the sandbox can't load (they need the DOM, AudioContext or network). */
export interface StubNames {
  globals: string[];
  methods: string[];
}

const now = () => performance.now();
const REST = new Set(['-', '~', '_']);

/** The key superdough looks a sound up by (superdough.mjs:538-551, :160), or null if nothing would play. */
export function soundKey(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.s === undefined) return 'triangle'; // superdough's default `s`
  if (typeof v.s !== 'string' || REST.has(v.s)) return null;
  const s = v.s.split(':')[0];
  return (typeof v.bank === 'string' && v.bank ? `${v.bank}_${s}` : s).toLowerCase();
}

type Snapshot = Map<string | symbol, PropertyDescriptor>;

function snapshot(target: object): Snapshot {
  const map: Snapshot = new Map();
  for (const key of Reflect.ownKeys(target)) map.set(key, Object.getOwnPropertyDescriptor(target, key)!);
  return map;
}

/** Undo additions and reassignments since `snap` (e.g. `register('foo', …)` or `globalThis.x = …`). */
function restore(target: object, snap: Snapshot) {
  for (const key of Reflect.ownKeys(target)) {
    const before = snap.get(key);
    const now = Object.getOwnPropertyDescriptor(target, key)!;
    if (!before) {
      if (now.configurable) delete (target as any)[key];
    } else if (before.value !== now.value || before.get !== now.get || before.set !== now.set) {
      if (now.configurable) Object.defineProperty(target, key, before);
    }
  }
}

export class Sandbox {
  /** Calls that reached a stub, for tests and debugging. */
  readonly stubCalls: string[] = [];
  private globalSnap: Snapshot = new Map();
  private protoSnap: Snapshot = new Map();

  private constructor(private readonly repl: any) {}

  static async create(): Promise<Sandbox> {
    await core.evalScope(core, mini, tonal);
    const repl = core.repl({
      transpiler,
      getTime: () => 0,
      defaultOutput: () => {},
      // The clock only starts on scheduler.start(), which autostart=false never calls. Belt and braces:
      setInterval: () => 0,
      clearInterval: () => {},
    });
    const sandbox = new Sandbox(repl);
    // repl.evaluate installs setcps/hush/all/each/cpm and Pattern.prototype.p etc. on first use.
    await repl.evaluate('s("bd")', false);
    sandbox.takeSnapshot();
    return sandbox;
  }

  /** Stub names that exist in the live scope but not here. Globals return silence; methods return `this`. */
  installStubs({ globals, methods }: StubNames) {
    const calls = this.stubCalls;
    const g = globalThis as any;
    for (const name of globals) {
      if (name in g) continue;
      g[name] = (..._args: unknown[]) => (calls.push(name), core.silence);
    }
    const proto = core.Pattern.prototype;
    for (const name of methods) {
      if (name in proto) continue;
      proto[name] = function (this: unknown) {
        calls.push(`.${name}`);
        return this;
      };
    }
    this.takeSnapshot();
  }

  private takeSnapshot() {
    this.globalSnap = snapshot(globalThis);
    this.protoSnap = snapshot(core.Pattern.prototype);
  }

  /** Transpile, evaluate and query 2 cycles of `code`. Never throws. */
  async check(code: string, cps: number): Promise<CheckResult> {
    const start = now();
    const fail = (stage: CheckStage, message: string): CheckResult => ({ ok: false, stage, message, ms: now() - start });
    try {
      try {
        transpiler(code, {});
      } catch (err) {
        return fail('syntax', errorText(err));
      }
      this.repl.setCps(cps); // so .cpm() sees the live tempo
      this.repl.state.evalError = undefined;
      // Swallows errors like the live repl: undefined on failure.
      const pattern = await this.repl.evaluate(code, false);
      if (pattern === undefined) return fail('eval', errorText(this.repl.state.evalError));
      // repl.evaluate substitutes `silence` when the code doesn't produce a pattern.
      if (pattern === core.silence) return fail('eval', 'The code produced no pattern.');
      let haps: any[];
      try {
        // Not queryArc: it catches query errors and returns [] (pattern.mjs:414-420).
        haps = pattern.query(new core.State(new core.TimeSpan(0, 2)));
      } catch (err) {
        return fail('query', errorText(err));
      }
      const onsets = haps.filter((h) => h.hasOnset());
      const sounds = new Set<string>();
      for (const h of onsets) {
        const key = soundKey(h.value);
        if (key) sounds.add(key);
      }
      return { ok: true, eventCount: onsets.length, sounds: [...sounds], ms: now() - start };
    } finally {
      restore(globalThis, this.globalSnap);
      restore(core.Pattern.prototype, this.protoSnap);
    }
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? 'unknown error');
}
