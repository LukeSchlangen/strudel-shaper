/**
 * Incremental parser for the structured output `{"options":[{"label":…,"code":…}, …]}`.
 * Feed it text deltas as they stream in. Each option is returned the moment its object closes,
 * so the first card can appear before the model has written the rest.
 *
 * It only tracks what it needs: string/escape state and a stack of open containers. An option is
 * an object whose parent is an array inside the top-level object. Each completed option slice is
 * checked with JSON.parse, so malformed elements are reported, not guessed at.
 */

export interface RawOption {
  label: string;
  code: string;
}

export interface ParseStep {
  options: RawOption[];
  errors: string[];
}

export class OptionStreamParser {
  private stack: string[] = [];
  private inString = false;
  private escaped = false;
  private started = false; // saw the top-level `{`
  private closed = false; // the top-level object closed
  private element = ''; // text of the option being read
  private inElement = false;
  private garbage = false;

  push(chunk: string): ParseStep {
    const step: ParseStep = { options: [], errors: [] };
    for (const c of chunk) this.consume(c, step);
    return step;
  }

  /** Call once the stream has ended. Reports anything left open; options already returned stand. */
  end(): string[] {
    if (!this.started) return ['The output contained no JSON object.'];
    if (!this.closed) return ['The output ended before the JSON was complete.'];
    return [];
  }

  private consume(c: string, step: ParseStep) {
    if (this.inElement) this.element += c;

    if (this.inString) {
      if (this.escaped) this.escaped = false;
      else if (c === '\\') this.escaped = true;
      else if (c === '"') this.inString = false;
      return;
    }

    if (this.stack.length === 0) {
      if (/\s/.test(c)) return;
      if (c === '{' && !this.started) {
        this.started = true;
        this.stack.push('{');
        return;
      }
      if (!this.garbage) {
        this.garbage = true;
        step.errors.push(this.closed ? 'Unexpected text after the JSON.' : 'Unexpected text before the JSON.');
      }
      return;
    }

    switch (c) {
      case '"':
        this.inString = true;
        return;
      case '{':
      case '[':
        if (c === '{' && this.isOptionDepth()) {
          this.inElement = true;
          this.element = '{';
        }
        this.stack.push(c);
        return;
      case '}':
      case ']': {
        const open = this.stack.pop();
        if ((c === '}' && open !== '{') || (c === ']' && open !== '[')) {
          step.errors.push(`Mismatched "${c}" in the output.`);
          return;
        }
        if (this.inElement && c === '}' && this.isOptionDepth()) {
          this.inElement = false;
          this.finishElement(step);
        }
        if (this.stack.length === 0) this.closed = true;
        return;
      }
    }
  }

  /** True when the stack is [top-level object, array]: an object opened here is an option. */
  private isOptionDepth() {
    return this.stack.length === 2 && this.stack[0] === '{' && this.stack[1] === '[';
  }

  private finishElement(step: ParseStep) {
    const text = this.element;
    this.element = '';
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      step.errors.push(`An option was not valid JSON: ${text.slice(0, 80)}`);
      return;
    }
    const problem = optionShapeProblem(value);
    if (problem) step.errors.push(problem);
    else step.options.push(value as RawOption);
  }
}

function optionShapeProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'An option was not an object.';
  const v = value as Record<string, unknown>;
  if (typeof v.label !== 'string' || typeof v.code !== 'string') return 'An option was missing its label or code.';
  const extra = Object.keys(v).filter((k) => k !== 'label' && k !== 'code');
  if (extra.length) return `An option had unexpected fields: ${extra.join(', ')}.`;
  return null;
}
