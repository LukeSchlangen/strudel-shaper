/** The last few instructions, newest first, for Up/Down in the instruction box. Memory only. */
export class InstructionHistory {
  private items: string[] = [];
  private cursor = -1; // -1 is the draft being typed

  constructor(private readonly limit = 10) {}

  add(instruction: string) {
    const text = instruction.trim();
    this.cursor = -1;
    if (!text) return;
    this.items = [text, ...this.items.filter((i) => i !== text)].slice(0, this.limit);
  }

  /** Start browsing again from the draft (call when the box opens). */
  reset() {
    this.cursor = -1;
  }

  /** Up: an older entry, or undefined if there is none. */
  older(): string | undefined {
    if (this.cursor + 1 >= this.items.length) return undefined;
    return this.items[++this.cursor];
  }

  /** Down: a newer entry, '' when back at the draft, undefined if already there. */
  newer(): string | undefined {
    if (this.cursor < 0) return undefined;
    this.cursor--;
    return this.cursor < 0 ? '' : this.items[this.cursor];
  }
}
