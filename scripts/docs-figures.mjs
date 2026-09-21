#!/usr/bin/env node
// Renders the README figures' HTML from the real renderer with a fixed fixture,
// so docs/*.png show what the code draws today rather than a hand-made mock-up.
//
//   npm run build
//   node scripts/docs-figures.mjs tmp/figures
//   # then screenshot each HTML at 3x, e.g. with Playwright:
//   #   shot tmp/figures/dark.html    docs/statusline-dark.png   1000 200 3 '#frame'
//   #   shot tmp/figures/light.html   docs/statusline-light.png  1000 200 3 '#frame'
//   #   shot tmp/figures/anatomy.html docs/anatomy.png           1100 420 3   # full page
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '../dist/render.js';

const outDir = process.argv[2] ?? 'tmp/figures';
mkdirSync(outDir, { recursive: true });

// ── Fixture: a Max 5x subscriber, mid-session, over pace on the 5-hour window ──
const now = new Date('2026-09-21T18:01:00+03:00').getTime();
const h = 60 * 60 * 1000;
const d = 24 * h;
const input = {
  stdin: {
    model: { display_name: 'Claude Sonnet 4.6' },
    effort_level: 'high',
    context_window: { current_usage: { input_tokens: 46_000 }, context_window_size: 200_000 },
    cwd: '/Users/md/code/lakelab',
  },
  usage: {
    planName: 'Max 5x',
    fiveHour: 31, fiveHourResetAt: new Date(now + 3 * h + 56 * 60 * 1000),
    sevenDay: 23, sevenDayResetAt: new Date(now + 4 * d + 20 * h),
    sonnet: 63, sonnetResetAt: new Date(now + 2 * d + 3 * h),
    opus: null, opusResetAt: null,
    design: null, designResetAt: null,
    routines: null, routinesResetAt: null,
    code: null, codeResetAt: null,
    extraUsage: { enabled: true, monthlyLimit: 5, usedCredits: 0, creditGrant: null },
    fetchedAt: now - 20_000,
  },
  git: { branch: 'main', isDirty: true },
  now,
  columns: 96,
  rows: 3,
};

const lines = [];
const log = console.log;
console.log = (s) => lines.push(s);
try { render(input); } finally { console.log = log; }

// ── ANSI → per-cell HTML ──────────────────────────────────────────────────────
const DARK = {
  bg: '#1e2127', fg: '#abb2bf', chrome: '#2c313a',
  c: { 30: '#3f4451', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b', 34: '#61afef', 35: '#c678dd', 36: '#56b6c2', 37: '#abb2bf',
       90: '#5c6370', 91: '#e06c75', 92: '#98c379', 93: '#e5c07b', 94: '#61afef', 95: '#c678dd', 96: '#56b6c2', 97: '#ffffff' },
};
const LIGHT = {
  bg: '#fafafa', fg: '#383a42', chrome: '#ebebeb',
  c: { 30: '#000000', 31: '#e45649', 32: '#50a14f', 33: '#c18401', 34: '#4078f2', 35: '#a626a4', 36: '#0184bc', 37: '#a0a1a7',
       90: '#a0a1a7', 91: '#e45649', 92: '#50a14f', 93: '#c18401', 94: '#4078f2', 95: '#a626a4', 96: '#0184bc', 97: '#ffffff' },
};

function xterm256(n, theme) {
  if (n < 16) return theme.c[n < 8 ? 30 + n : 90 + n - 8];
  if (n >= 232) { const v = 8 + 10 * (n - 232); return `rgb(${v},${v},${v})`; }
  const i = n - 16, r = Math.floor(i / 36), g = Math.floor((i % 36) / 6), b = i % 6;
  const s = (x) => (x === 0 ? 0 : 55 + 40 * x);
  return `rgb(${s(r)},${s(g)},${s(b)})`;
}

function cells(line, theme) {
  const out = [];
  let fg = null, bold = false, dim = false;
  const re = /\x1b\[([0-9;]*)m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)|([\s\S])/gu;
  let m;
  while ((m = re.exec(line))) {
    if (m[1] !== undefined) {
      for (const code of m[1].split(';').map(Number)) {
        if (code === 0) { fg = null; bold = false; dim = false; }
        else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 22) { bold = false; dim = false; }
        else if (code === 39) fg = null;
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = theme.c[code];
      }
      if (/^38;5;\d+$/.test(m[1])) fg = xterm256(Number(m[1].split(';')[2]), theme);
      continue;
    }
    if (m[2] === undefined) continue; // OSC 8 link open/close
    const ch = m[2];
    const style = [fg ? `color:${fg}` : '', bold ? 'font-weight:700' : '', dim ? 'opacity:.55' : ''].filter(Boolean).join(';');
    const text = ch === ' ' ? '&nbsp;' : ch.replace('&', '&amp;').replace('<', '&lt;');
    out.push(style ? `<i style="${style}">${text}</i>` : `<i>${text}</i>`);
  }
  return out.join('');
}

const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ''));
const cols = Math.max(...plain.map((l) => [...l].length));

function page(theme, body, extraCss = '', bar = true) {
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:transparent}
    #frame{display:inline-block;background:${theme.bg};color:${theme.fg};border-radius:12px;padding:0 0 14px;
      font:14px/22px Menlo,'SF Mono','DejaVu Sans Mono',Consolas,monospace;box-shadow:0 10px 30px rgba(0,0,0,.18);margin:24px}
    .bar{height:34px;background:${theme.chrome};border-radius:12px 12px 0 0;position:relative}
    .bar b{position:absolute;top:11px;width:12px;height:12px;border-radius:50%}
    .bar b:nth-child(1){left:14px;background:#ff5f57}.bar b:nth-child(2){left:34px;background:#febc2e}.bar b:nth-child(3){left:54px;background:#28c840}
    pre{margin:0;padding:12px 18px 0;font:inherit;white-space:pre}
    i{font-style:normal;display:inline-block;width:1ch;text-align:center}
    ${extraCss}</style>
    <div id="frame">${bar ? '<div class="bar"><b></b><b></b><b></b></div>' : ''}${body}</div>`;
}

for (const [name, theme] of [['dark', DARK], ['light', LIGHT]]) {
  const body = `<pre>${lines.map((l) => cells(l, theme)).join('\n')}</pre>`;
  writeFileSync(join(outDir, `${name}.html`), page(theme, body));
}

// ── Anatomy: the same render with call-outs ───────────────────────────────────
// Each call-out names a segment by a substring of the plain line; side is where
// the label sits, row staggers labels so neighbours do not overlap.
const callouts = [
  { line: 0, find: 'sonnet high', side: 'top', row: 1, text: 'model family · effort' },
  { line: 0, find: 'ctx:', width: 19, side: 'top', row: 0, text: 'context window used' },
  { line: 0, find: 'dashboard', side: 'top', row: 1, text: 'opens the HTML dashboard' },
  { line: 0, find: 'lakelab', width: 19, side: 'top', row: 0, text: 'project · branch, * = dirty' },
  { line: 1, find: 'max 5x', side: 'bottom', row: 2, text: 'plan' },
  { line: 1, find: '5h:', width: 19, side: 'bottom', row: 3, text: '5-hour session quota' },
  { line: 1, find: '↗', width: 5, side: 'bottom', row: 2, text: 'pace: projected use at reset' },
  { line: 1, find: '◔', width: 6, side: 'bottom', row: 3, text: 'time to reset · glyph = window elapsed' },
  { line: 1, find: 'snt:', width: 19, side: 'bottom', row: 1, text: '7-day, Sonnet only' },
  { line: 2, find: '⟳', width: 6, side: 'bottom', row: 0, text: 'last fetch' },
  { line: 2, find: '7d:', width: 19, side: 'bottom', row: 1, text: '7-day, all models' },
  { line: 2, find: '$:', width: 21, side: 'bottom', row: 0, text: 'extra usage: spent · pace · projected / limit' },
];
const LH = 22, PAD_L = 18, PAD_T = 12, BAND = 26;
const topRows = 2, bottomRows = 4;
let marks = '';
for (const c of callouts) {
  const col = [...plain[c.line]].findIndex((_, i, a) => a.slice(i, i + [...c.find].length).join('') === c.find);
  if (col < 0) { console.error(`callout not found: ${c.find}`); continue; }
  const width = c.width ?? [...c.find].length;
  const yLine = PAD_T + c.line * LH; // top of the text line inside <pre>
  const under = yLine + LH - 3;
  const yLabel = c.side === 'top' ? -((topRows - c.row) * BAND) + 4 : PAD_T + 3 * LH + (c.row + 1) * BAND;
  const yFrom = c.side === 'top' ? yLabel + 6 : under;
  const yTo = c.side === 'top' ? yLine + 2 : yLabel - 12;
  marks += `<u style="left:calc(${PAD_L}px + ${col}ch);width:${width}ch;top:${under}px"></u>`;
  marks += `<s style="left:calc(${PAD_L}px + ${col}ch + 0.5ch);top:${Math.min(yFrom, yTo)}px;height:${Math.abs(yTo - yFrom)}px"></s>`;
  marks += `<em style="left:calc(${PAD_L}px + ${col}ch);top:${yLabel}px">${c.text}</em>`;
}
const anatomyCss = `
  html,body{background:#fff;width:max-content}
  #frame{margin:${topRows * BAND + 30}px 24px ${bottomRows * BAND + 40}px}
  #frame{padding-top:6px}
  .stage{position:relative}
  pre{position:relative;z-index:1}
  u,s,em{position:absolute;display:block}
  u{height:2px;background:#e5c07b;border-radius:1px}
  s{width:1px;background:#e5c07b;opacity:.7}
  em{font:600 12px/16px ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#e5c07b;white-space:nowrap;transform:translateY(-50%);padding-left:0}
`;
const anatomyBody = `<div class="stage"><pre>${lines.map((l) => cells(l, DARK)).join('\n')}</pre>${marks}</div>`;
writeFileSync(join(outDir, 'anatomy.html'), page(DARK, anatomyBody, anatomyCss, false));

console.log(plain.join('\n'));
console.log(`\n${cols} columns → ${outDir}/{dark,light,anatomy}.html`);
