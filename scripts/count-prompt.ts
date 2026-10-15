/**
 * Real token counts for each part of the system prompt (the free count_tokens endpoint; needs
 * ANTHROPIC_API_KEY). `npm run count:prompt`
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { ROLE, soundsSystem, staticSystem } from '../server/prompt';
import { summariseSounds } from '../src/soundSummary';

export async function main() {
  const client = new Anthropic();
  const count = async (text: string) =>
    (await client.messages.countTokens({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: text }] })).input_tokens;
  const base = await count('x');
  const reference = readFileSync('src/generated/strudel-reference.md', 'utf8');
  const sounds = summariseSounds(JSON.parse(readFileSync('src/generated/sounds.json', 'utf8')));
  const parts: Array<[string, string]> = [
    ['role and rules', ROLE],
    ['reference', reference],
    ['sound summary', sounds],
    ['system block 1 (role + reference)', staticSystem(reference)],
    ['system block 2 (sounds)', soundsSystem(sounds)],
  ];
  for (const [name, text] of parts) console.log(`${name.padEnd(36)} ${String(text.length).padStart(6)} chars  ${String((await count(text)) - base).padStart(5)} tokens`);
}
