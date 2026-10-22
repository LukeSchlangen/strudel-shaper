// `npm run check:key`: builds, then checks that the API key appears nowhere in dist/.
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
const geminiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)?.trim();
const appAccessKey = process.env.APP_ACCESS_KEY?.trim();
execSync('npx vite build', { stdio: 'inherit' });
const files = [];
const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f))));
walk('dist');
const hits = files.filter((f) => {
  const text = readFileSync(f, 'latin1');
  return (
    (anthropicKey && text.includes(anthropicKey)) ||
    (geminiKey && text.includes(geminiKey)) ||
    (appAccessKey && appAccessKey.length >= 6 && text.includes(appAccessKey)) ||
    /sk-ant-[A-Za-z0-9_-]{10,}/.test(text) ||
    /AIza[0-9A-Za-z-_]{35}/.test(text) ||
    text.includes('ANTHROPIC_API_KEY') ||
    text.includes('GEMINI_API_KEY')
  );
});
console.log(`[check:key] scanned ${files.length} files in dist/: ${hits.length ? `FOUND in ${hits.join(', ')}` : 'no API keys leaked in dist/'}`);
process.exit(hits.length ? 1 : 0);
