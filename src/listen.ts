import '@strudel/repl/repl-component.mjs';
import { getAudioContext } from '@strudel/webaudio';
import { silence } from '@strudel/core';
import { LARGE_CHANGE_CHARS, diffSegments, type DiffGranularity } from './diff';
import { reasonLabel, type RetryReason } from './feedback';
import { Quantizer } from './quantize';
import { splice } from './splice';
import type { Report, RequestResult } from '../eval/summary';

/**
 * eval/listen.html: step through an eval report's requests and audition each one's options in
 * the real editor, beat-quantized like the tray, so quality can be judged by ear. A rating and a
 * note per request are kept in localStorage (per report) and can be exported as JSON.
 */

const host = document.createElement('strudel-editor') as HTMLElement & { editor: any };
host.setAttribute('code', '// pick a report');
document.getElementById('editor-wrap')!.append(host);
const mirror = host.editor;
const quantizer = new Quantizer(mirror.repl.scheduler);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reportSelect = $<HTMLSelectElement>('report');
const trayEl = $('tray');
const statusEl = $('status');

$('play').addEventListener('click', () => mirror.evaluate());
$('stop').addEventListener('click', () => mirror.stop());
// Resume audio inside the first key gesture, as main.ts does.
window.addEventListener('keydown', () => getAudioContext().resume(), { once: true, capture: true });

const reports = import.meta.glob('../eval/reports/*.json', { query: '?url', import: 'default' }) as Record<string, () => Promise<string>>;
const names = Object.keys(reports).sort().reverse();
reportSelect.innerHTML = names.map((n) => `<option value="${n}">${n.split('/').pop()}</option>`).join('') || '<option>no reports in eval/reports</option>';

let report: Report | null = null;
let index = 0;
let heard = 0;
/**
 * Fix reports whose original doesn't evaluate: what was playing when the request was shown (or
 * silence). 0 goes back to it, as 0/Esc do in the tray, instead of evaluating the broken buffer.
 */
let snapshot: any = null;

type Notes = Record<string, { ratings: Record<number, string>; note: string }>;
const notesKey = () => `shaper-listen:${report?.label}:${report?.createdAt}`;
const loadNotes = (): Notes => {
  try {
    return JSON.parse(localStorage.getItem(notesKey()) ?? '{}');
  } catch {
    return {};
  }
};
const saveNotes = (n: Notes) => {
  try {
    localStorage.setItem(notesKey(), JSON.stringify(n));
  } catch {
    /* private mode: notes just aren't kept */
  }
};

async function openReport(r: Report) {
  report = r;
  index = 0;
  await show();
}

reportSelect.addEventListener('change', async () => {
  const url = await reports[reportSelect.value]?.();
  if (url) await openReport(await (await fetch(url)).json());
});
$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) await openReport(JSON.parse(await file.text()));
});
$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ report: report?.label, createdAt: report?.createdAt, notes: loadNotes() }, null, 1)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `listen-notes-${report?.label}.json` });
  a.click();
});

async function step(d: number) {
  if (!report) return;
  index = (index + d + report.results.length) % report.results.length;
  await show();
}

const current = (): RequestResult | null => report?.results[index] ?? null;
const ready = (r: RequestResult) => r.slots.map((s, i) => ({ ...s, slot: i + 1 })).filter((s) => s.status === 'ready' && s.code);

async function show() {
  const r = current();
  if (!r || !report) return;
  heard = 0;
  mirror.setCode(r.buffer);
  snapshot = r.originalBroken ? (mirror.repl.scheduler.started ? quantizer.playing() : silence) : null;
  if (mirror.repl.scheduler.started && !r.originalBroken) await evaluate(r.buffer);
  $('position').textContent = `${index + 1}/${report.results.length}`;
  const fixing = r.diagnosis?.message ? ` · ${r.mode}: ${r.diagnosis.message}${r.diagnosis.line ? ` (line ${r.diagnosis.line})` : ''}` : '';
  $('request-meta').textContent = `${r.id}${fixing} · "${r.instruction || '(no instruction)'}" · first card ${sec(r.firstCardMs)} · ${r.error ?? ''}`;
  render();
}

const sec = (ms?: number) => (ms === undefined ? '—' : `${(ms / 1000).toFixed(2)} s`);

async function evaluate(code: string) {
  quantizer.armed = true;
  try {
    await mirror.repl.evaluate(code);
  } finally {
    quantizer.armed = false;
  }
}

async function audition(slot: number) {
  const r = current();
  if (!r) return;
  const option = r.slots[slot - 1];
  if (slot !== 0 && (option?.status !== 'ready' || !option.code)) return;
  heard = slot;
  render();
  if (slot === 0 && snapshot) return quantizer.swapTo(snapshot);
  await evaluate(slot === 0 ? r.buffer : splice(r.buffer, r.selection, option.code!));
}

function render() {
  const r = current();
  if (!r) return;
  const notes = loadNotes();
  const mine = notes[r.id] ?? { ratings: {}, note: '' };
  const card = (slot: number, label: string, body: string, extra = '') =>
    `<div class="card ${slot === heard ? 'heard' : ''}" data-slot="${slot}"><b>${slot}</b> ${esc(label)}${extra}<code>${body}</code></div>`;
  const generate = r.mode === 'generate';
  const cards = [card(0, generate ? 'nothing' : r.originalBroken ? 'original (broken)' : 'original', esc(r.selection.text))];
  const granularity: DiffGranularity = r.mode === 'fix-minimal' ? 'char' : 'word';
  r.slots.forEach((s, i) => {
    const slot = i + 1;
    if (s.status !== 'ready' || !s.code) {
      const why = s.drop ? reasonLabel(s.drop.reason as RetryReason, s.drop.message) : s.status;
      cards.push(`<div class="card dropped"><b>${slot}</b> ${esc(why)}<code>${esc(s.attempts.at(-1)?.code ?? '')}</code></div>`);
      return;
    }
    const large = granularity === 'char' && (s.changeSize ?? 0) > LARGE_CHANGE_CHARS ? ['large change'] : [];
    const badges = [...(s.warnings ?? []), ...(s.retried ? ['retried'] : []), ...(s.checkedAlone ? ['checked alone'] : []), ...large]
      .map((b) => `<span class="badge">${esc(b)}</span>`)
      .join('');
    const rating = `<select data-rate="${slot}">${['', 'great', 'good', 'meh', 'bad', 'broken'].map((v) => `<option ${mine.ratings[slot] === v ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
    const size = s.changeSize !== undefined && granularity === 'char' ? ` <small>${s.changeSize} ch</small>` : '';
    cards.push(card(slot, s.label ?? '', generate ? esc(s.code) : diff(r.selection.text, s.code, granularity), badges + size + rating));
  });
  trayEl.innerHTML = `<div class="meta">1–4 audition · 0 original · N/P request · T swap: ${quantizer.mode} · ${ready(r).length} cards</div><div class="cards">${cards.join('')}</div><textarea id="notes" rows="2" placeholder="Notes for this request">${esc(mine.note)}</textarea>`;
  trayEl.querySelectorAll<HTMLSelectElement>('select[data-rate]').forEach((sel) =>
    sel.addEventListener('change', () => {
      const all = loadNotes();
      all[r.id] = { ...(all[r.id] ?? { ratings: {}, note: '' }) };
      all[r.id].ratings[Number(sel.dataset.rate)] = sel.value;
      saveNotes(all);
    }),
  );
  $<HTMLTextAreaElement>('notes').addEventListener('input', (e) => {
    const all = loadNotes();
    all[r.id] = { ...(all[r.id] ?? { ratings: {}, note: '' }), note: (e.target as HTMLTextAreaElement).value };
    saveNotes(all);
  });
  statusEl.textContent = `${report?.label} · ${heard === 0 ? 'original' : `option ${heard}`}`;
}

const diff = (a: string, b: string, granularity: DiffGranularity) =>
  diffSegments(a, b, granularity)
    .map(({ kind, text, shown }) => (kind === 'same' ? esc(text) : `<${kind}${granularity === 'char' ? ' class="char"' : ''}>${esc(shown ?? text)}</${kind}>`))
    .join('');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

trayEl.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-slot]');
  if (el && !(e.target as HTMLElement).closest('select')) void audition(Number(el.dataset.slot));
});

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (e.metaKey || e.ctrlKey || e.altKey || t.closest('textarea, input, select, .cm-editor')) return;
  if (/^[0-4]$/.test(e.key)) void audition(Number(e.key));
  else if (e.key === 'n' || e.key === 'N') void step(1);
  else if (e.key === 'p' || e.key === 'P') void step(-1);
  else if (e.key === 't' || e.key === 'T') {
    quantizer.cycleMode();
    render();
  } else return;
  e.preventDefault();
});

if (names.length) reportSelect.dispatchEvent(new Event('change'));
