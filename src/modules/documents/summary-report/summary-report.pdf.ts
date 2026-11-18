import PDFDocument = require('pdfkit');
import { readFileSync } from 'fs';
import { join } from 'path';
import { formatGeneratedDate, formatReportDate, formatReportRange } from '@/modules/voice/utils/summary-report.util';
import { SummaryReport, TranscriptItem } from './summary-report.types';

const LOGO_PNG = readFileSync(join(__dirname, '..', '..', '..', 'assets', 'cognix-logo.png'));
const LOGO_ASPECT = 180 / 600;

// ── Palette and page geometry ────────────────────────────────────────────────
const NAVY = '#101f3c';
const BLUE = '#2f5fd0';
const BLUE_SOFT = '#8fb0ff';
const INK = '#1a1f2e';
const BODY = '#2b2f3a';
const MUTED = '#6b7280';
const RULE = '#dfe3ea';
const CREAM = '#f6f2e8';
const CREAM_EDGE = '#e2dac3';
const INSIGHT_FILL = '#eaf0fd';
const SPEAKER_COLOURS = ['#9a6a2a', '#2f7d5b', '#7b3f8c', '#b13a32', '#4f6490', '#6f8a2c', '#a2602c', '#2f6ea0', '#8a4f72', '#2f7f86', '#6b4e9a', '#9a3f5f'];

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 64;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const SERIF = 'Times-Roman';
const SERIF_BOLD = 'Times-Bold';
const SERIF_ITALIC = 'Times-Italic';

/**
 * The built-in PDF fonts only cover Western characters. Keep what they can draw, fold accented letters to
 * their base letter (so "Adé" stays readable), and replace anything else with "?" instead of garbling it.
 */
export function pdfSafe(text: string): string {
  const keep = /[ -~ -ÿ‘’“”–—•…€™\n]/;
  let out = '';
  for (const ch of String(text ?? '')) {
    if (keep.test(ch)) { out += ch; continue; }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    out += /^[ -~]+$/.test(base) ? base : '?';
  }
  return out;
}

/** Mixes a #rrggbb colour with white (amount 0..1 of white) — for light chip backgrounds. */
function tint(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => mix(c).toString(16).padStart(2, '0')).join('')}`;
}

export interface PdfRenderOptions {
  /** Disable stream compression (tests read the text back out of the raw content streams). */
  compress?: boolean;
}

export function renderSummaryReportPdf(report: SummaryReport, options: PdfRenderOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_X, right: MARGIN_X },
      bufferPages: true,
      compress: options.compress ?? true,
      info: { Title: pdfSafe(report.title), Author: 'CognIX AI', Subject: 'Meeting Intelligence Report' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      draw(doc, report);
      addFooters(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

type Doc = InstanceType<typeof PDFDocument>;

const limitY = () => PAGE_H - MARGIN_BOTTOM;

function spaced(doc: Doc, text: string, x: number, y: number, opts: { font: string; size: number; color: string; spacing?: number; width?: number; align?: 'left' | 'right' | 'center' }) {
  doc.font(opts.font).fontSize(opts.size).fillColor(opts.color)
    .text(pdfSafe(text), x, y, { characterSpacing: opts.spacing ?? 0, width: opts.width, align: opts.align, lineBreak: opts.width !== undefined });
}

function textHeight(doc: Doc, text: string, font: string, size: number, width: number, lineGap = 0): number {
  doc.font(font).fontSize(size);
  return doc.heightOfString(pdfSafe(text), { width, lineGap });
}

/** Starts a new page if `needed` points don't fit; returns the y to continue from. */
function ensure(doc: Doc, y: number, needed: number): number {
  if (y + needed <= limitY()) return y;
  doc.addPage();
  return MARGIN_TOP;
}

function draw(doc: Doc, report: SummaryReport) {
  const speakerIndex = new Map<string, number>();
  for (const s of report.sessions) {
    for (const item of s.transcript) {
      if (item.kind === 'turn' && !speakerIndex.has(item.speaker)) speakerIndex.set(item.speaker, speakerIndex.size);
    }
  }
  const colourOf = (speaker: string) => SPEAKER_COLOURS[(speakerIndex.get(speaker) ?? 0) % SPEAKER_COLOURS.length];

  let y = drawCover(doc, report);
  y = drawContents(doc, report, y);
  report.sessions.forEach((session, i) => {
    doc.addPage();
    y = MARGIN_TOP;
    y = drawSessionBanner(doc, session.number, session.date, session.title, session.description, y);

    y = drawSectionHeading(doc, 'THE SHORT VERSION', 'Summary', y);
    y = drawSummaryBox(doc, session.summary, y);

    if (session.transcript.length > 0) {
      y = ensure(doc, y + 14, 120);
      y = drawSectionHeading(doc, 'WORD FOR WORD', 'Transcript', y);
      y = drawTranscript(doc, session.transcript, colourOf, y);
    }
    if (session.keyInsights.length > 0) {
      y = ensure(doc, y + 14, 120);
      y = drawSectionHeading(doc, 'WHAT STOOD OUT', 'Key Insights', y);
      y = drawKeyInsights(doc, session.keyInsights, y);
    }
    if (session.actionPoints.length > 0) {
      y = ensure(doc, y + 14, 140);
      y = drawSectionHeading(doc, 'WHAT HAPPENS NEXT', 'Action Points / Next Steps', y);
      y = drawActionPoints(doc, session.actionPoints, y);
    }
    void i;
  });
}

// ── Cover ─────────────────────────────────────────────────────────────────────
function drawCover(doc: Doc, report: SummaryReport): number {
  const logoW = 96;
  doc.image(LOGO_PNG, MARGIN_X, 40, { width: logoW });
  spaced(doc, 'MEETING INTELLIGENCE REPORT', MARGIN_X + logoW + 26, 50, { font: SERIF, size: 9, color: MUTED, spacing: 1.4 });

  const pad = 28;
  const innerW = CONTENT_W - pad * 2;
  const titleH = textHeight(doc, report.title, SERIF, 28, innerW, 3);
  const top = 92;
  const bannerH = pad + 14 + 12 + titleH + 22 + 20 + pad;
  doc.rect(MARGIN_X, top, CONTENT_W, bannerH).fill(NAVY);

  const range = formatReportRange(report.sessions.map((s) => s.date));
  spaced(doc, range, MARGIN_X + pad, top + pad, { font: SERIF, size: 8.5, color: BLUE_SOFT, spacing: 1.4 });
  doc.font(SERIF).fontSize(28).fillColor('#ffffff').text(pdfSafe(report.title), MARGIN_X + pad, top + pad + 26, { width: innerW, lineGap: 3 });

  const rowY = top + pad + 26 + titleH + 22;
  const chipText = `${report.sessions.length} ${report.sessions.length === 1 ? 'SESSION' : 'SESSIONS'}`;
  doc.font(SERIF_BOLD).fontSize(8);
  const chipW = doc.widthOfString(pdfSafe(chipText), { characterSpacing: 1 }) + 16;
  doc.roundedRect(MARGIN_X + pad, rowY - 3, chipW, 16, 2).fill('#3b6fe0');
  spaced(doc, chipText, MARGIN_X + pad + 8, rowY + 1, { font: SERIF_BOLD, size: 8, color: '#ffffff', spacing: 1 });
  spaced(doc, `Generated by CognIX AI  ·  ${formatGeneratedDate(report.generatedAt)}`, MARGIN_X + pad + chipW + 14, rowY, { font: SERIF, size: 9.5, color: '#c3cde6' });

  return top + bannerH;
}

// ── Contents table ────────────────────────────────────────────────────────────
function drawContents(doc: Doc, report: SummaryReport, startY: number): number {
  let y = startY + 40;
  y = drawSectionHeading(doc, 'CONTENTS', 'Sessions at a glance', y);

  const cols = [{ w: 40 }, { w: 84 }, { w: 263.28 }, { w: 96 }];
  const x0 = MARGIN_X;
  const headY = y;
  const heads = ['NO.', 'DATE', 'MEETING', 'ACTION POINTS'];
  let cx = x0;
  heads.forEach((h, i) => {
    spaced(doc, h, cx + 8, headY + 6, { font: SERIF, size: 7.5, color: MUTED, spacing: 1.1, width: cols[i].w - 16, align: i === 3 ? 'right' : 'left' });
    cx += cols[i].w;
  });
  y = headY + 22;
  doc.moveTo(x0, y).lineTo(x0 + CONTENT_W, y).lineWidth(0.8).strokeColor(INK).stroke();

  report.sessions.forEach((s) => {
    const titleH = textHeight(doc, s.title, SERIF, 10.5, cols[2].w - 16, 1);
    const rowH = Math.max(34, titleH + 20);
    y = ensure(doc, y, rowH);
    let x = x0;
    spaced(doc, String(s.number).padStart(2, '0'), x + 8, y + rowH / 2 - 8, { font: SERIF, size: 16, color: BLUE });
    x += cols[0].w;
    spaced(doc, formatReportDate(s.date), x + 8, y + rowH / 2 - 5, { font: SERIF, size: 9.5, color: BODY });
    x += cols[1].w;
    doc.font(SERIF).fontSize(10.5).fillColor(INK).text(pdfSafe(s.title), x + 8, y + (rowH - titleH) / 2, { width: cols[2].w - 16, lineGap: 1 });
    x += cols[2].w;
    spaced(doc, String(s.actionPoints.length), x + 8, y + rowH / 2 - 7, { font: SERIF, size: 13, color: INK, width: cols[3].w - 16, align: 'right' });
    y += rowH;
    doc.moveTo(x0, y).lineTo(x0 + CONTENT_W, y).lineWidth(0.5).strokeColor(RULE).stroke();
  });
  return y + 8;
}

// ── Session banner and section scaffolding ────────────────────────────────────
function drawSessionBanner(doc: Doc, number: number, isoDate: string, title: string, description: string, y: number): number {
  const pad = 24;
  const innerW = CONTENT_W - pad * 2;
  const titleH = textHeight(doc, title, SERIF, 21, innerW, 2);
  const descH = description ? textHeight(doc, description, SERIF_ITALIC, 10.5, innerW, 2) : 0;
  const h = pad + 12 + titleH + (descH ? 10 + descH : 0) + pad;
  doc.rect(MARGIN_X, y, CONTENT_W, h).fill(NAVY);
  spaced(doc, `SESSION ${String(number).padStart(2, '0')}  ·  ${formatReportDate(isoDate)}`, MARGIN_X + pad, y + pad, { font: SERIF_BOLD, size: 8, color: BLUE_SOFT, spacing: 1.3 });
  doc.font(SERIF).fontSize(21).fillColor('#ffffff').text(pdfSafe(title), MARGIN_X + pad, y + pad + 16, { width: innerW, lineGap: 2 });
  if (description) {
    doc.font(SERIF_ITALIC).fontSize(10.5).fillColor('#c9d3ea').text(pdfSafe(description), MARGIN_X + pad, y + pad + 16 + titleH + 10, { width: innerW, lineGap: 2 });
  }
  return y + h + 30;
}

function drawSectionHeading(doc: Doc, label: string, heading: string, y: number): number {
  y = ensure(doc, y, 78);
  spaced(doc, label, MARGIN_X, y, { font: SERIF, size: 9, color: BLUE, spacing: 1.5 });
  doc.font(SERIF).fontSize(23).fillColor(INK).text(pdfSafe(heading), MARGIN_X, y + 16, { width: CONTENT_W, lineBreak: false });
  const ruleY = y + 16 + 32;
  doc.moveTo(MARGIN_X, ruleY).lineTo(MARGIN_X + CONTENT_W, ruleY).lineWidth(0.6).strokeColor(RULE).stroke();
  return ruleY + 16;
}

// ── Summary ───────────────────────────────────────────────────────────────────
function drawSummaryBox(doc: Doc, summary: string, y: number): number {
  const pad = 18;
  const innerW = CONTENT_W - pad * 2;
  const paragraphs = (summary || 'No summary was generated for this session.').split(/\n{1,}/).map((p) => p.trim()).filter(Boolean);
  let i = 0;
  while (i < paragraphs.length) {
    // Fit as many paragraphs as possible in this page's box; continue in a new box on the next page.
    y = ensure(doc, y, 70);
    const startY = y;
    let used = pad;
    const chunk: Array<{ text: string; h: number }> = [];
    while (i < paragraphs.length) {
      const h = textHeight(doc, paragraphs[i], SERIF, 11.5, innerW, 4);
      const gap = chunk.length ? 8 : 0;
      if (chunk.length && startY + used + gap + h + pad > limitY()) break;
      chunk.push({ text: paragraphs[i], h });
      used += gap + h;
      i += 1;
    }
    const boxH = used + pad;
    doc.rect(MARGIN_X, startY, CONTENT_W, boxH).fillAndStroke(CREAM, CREAM_EDGE);
    let ty = startY + pad;
    for (const p of chunk) {
      doc.font(SERIF).fontSize(11.5).fillColor(BODY).text(pdfSafe(p.text), MARGIN_X + pad, ty, { width: innerW, lineGap: 4 });
      ty += p.h + 8;
    }
    y = startY + boxH;
  }
  return y + 14;
}

// ── Transcript ────────────────────────────────────────────────────────────────
function drawTranscript(doc: Doc, items: TranscriptItem[], colourOf: (s: string) => string, startY: number): number {
  let y = startY;
  for (const item of items) {
    if (item.kind === 'turn') {
      const colour = colourOf(item.speaker);
      const label = item.speaker.toUpperCase();
      doc.font(SERIF_BOLD).fontSize(8.5);
      const chipW = doc.widthOfString(pdfSafe(label), { characterSpacing: 1 }) + 18;
      const firstLines = Math.min(3, Math.ceil(textHeight(doc, item.text, SERIF, 11.5, CONTENT_W - 4, 3) / 17));
      y = ensure(doc, y, 24 + firstLines * 17);
      doc.roundedRect(MARGIN_X, y, Math.min(chipW, CONTENT_W), 17, 2).fill(tint(colour, 0.86));
      spaced(doc, label, MARGIN_X + 9, y + 4.5, { font: SERIF_BOLD, size: 8.5, color: colour, spacing: 1 });
      doc.font(SERIF).fontSize(11.5).fillColor(INK).text(pdfSafe(item.text), MARGIN_X + 2, y + 26, { width: CONTENT_W - 4, lineGap: 3 });
      y = doc.y + 16;
    } else {
      y = drawInsightBox(doc, item.bullets, y);
    }
  }
  return y;
}

function drawInsightBox(doc: Doc, bullets: string[], startY: number): number {
  const padX = 14;
  const textX = MARGIN_X + padX + 12;
  const textW = CONTENT_W - padX * 2 - 12;
  const heights = bullets.map((b) => textHeight(doc, b, SERIF, 9.8, textW, 2));
  const headerH = 22;
  const boxH = headerH + heights.reduce((a, h) => a + h + 5, 0) + 10;
  const y = ensure(doc, startY, Math.min(boxH, 200));
  doc.rect(MARGIN_X, y, CONTENT_W, boxH).fillAndStroke(INSIGHT_FILL, '#c5d3f3');
  doc.rect(MARGIN_X, y, 4, boxH).fill(NAVY);
  // header: "COGNIX AI" tag + caption
  doc.font(SERIF_BOLD).fontSize(7);
  const tagW = doc.widthOfString('COGNIX AI', { characterSpacing: 1 }) + 12;
  doc.rect(MARGIN_X + padX, y + 8, tagW, 12).fill(NAVY);
  spaced(doc, 'COGNIX AI', MARGIN_X + padX + 6, y + 11, { font: SERIF_BOLD, size: 7, color: '#ffffff', spacing: 1 });
  spaced(doc, 'insights & suggestions', MARGIN_X + padX + tagW + 8, y + 10.5, { font: SERIF_ITALIC, size: 8.5, color: BLUE });
  let by = y + headerH + 6;
  bullets.forEach((b, i) => {
    doc.circle(MARGIN_X + padX + 3, by + 5.2, 1.7).fill(BLUE);
    doc.font(SERIF).fontSize(9.8).fillColor('#27304a').text(pdfSafe(b), textX, by, { width: textW, lineGap: 2 });
    by += heights[i] + 5;
  });
  return y + boxH + 20;
}

// ── Key insights and action points ────────────────────────────────────────────
function drawKeyInsights(doc: Doc, insights: string[], startY: number): number {
  let y = startY;
  const numW = 44;
  const textW = CONTENT_W - numW - 8;
  insights.forEach((text, i) => {
    const h = textHeight(doc, text, SERIF, 11, textW, 3);
    const rowH = h + 22;
    y = ensure(doc, y, rowH);
    spaced(doc, String(i + 1).padStart(2, '0'), MARGIN_X, y + 10, { font: SERIF, size: 15, color: BLUE });
    doc.font(SERIF).fontSize(11).fillColor(INK).text(pdfSafe(text), MARGIN_X + numW, y + 11, { width: textW, lineGap: 3 });
    y += rowH;
    doc.moveTo(MARGIN_X, y).lineTo(MARGIN_X + CONTENT_W, y).lineWidth(0.5).strokeColor(RULE).stroke();
  });
  return y + 16;
}

function drawActionPoints(doc: Doc, actions: string[], startY: number): number {
  const cols = { num: 40, action: 283, owner: 90, done: 70.28 };
  const drawHeader = (y: number) => {
    doc.rect(MARGIN_X, y, CONTENT_W, 22).fill(NAVY);
    let x = MARGIN_X;
    spaced(doc, '#', x + 12, y + 7, { font: SERIF_BOLD, size: 7.5, color: '#ffffff', spacing: 1 });
    x += cols.num;
    spaced(doc, 'ACTION', x + 8, y + 7, { font: SERIF_BOLD, size: 7.5, color: '#ffffff', spacing: 1.2 });
    x += cols.action;
    spaced(doc, 'OWNER', x + 8, y + 7, { font: SERIF_BOLD, size: 7.5, color: '#ffffff', spacing: 1.2 });
    x += cols.owner;
    spaced(doc, 'DONE', x + 8, y + 7, { font: SERIF_BOLD, size: 7.5, color: '#ffffff', spacing: 1.2 });
    return y + 22;
  };
  let y = ensure(doc, startY, 70);
  y = drawHeader(y);
  actions.forEach((text, i) => {
    const h = textHeight(doc, text, SERIF, 10.8, cols.action - 16, 2.5);
    const rowH = Math.max(34, h + 20);
    if (y + rowH > limitY()) {
      doc.addPage();
      y = drawHeader(MARGIN_TOP);
    }
    doc.rect(MARGIN_X, y, CONTENT_W, rowH).fill(i % 2 ? '#ffffff' : '#f7f8fb');
    let x = MARGIN_X;
    spaced(doc, String(i + 1).padStart(2, '0'), x + 10, y + rowH / 2 - 8, { font: SERIF, size: 14, color: BLUE });
    x += cols.num;
    doc.font(SERIF).fontSize(10.8).fillColor(INK).text(pdfSafe(text), x + 8, y + (rowH - h) / 2, { width: cols.action - 16, lineGap: 2.5 });
    x += cols.action;
    doc.rect(x + 8, y + 8, cols.owner - 16, rowH - 16).lineWidth(0.5).strokeColor(RULE).stroke();
    x += cols.owner;
    doc.rect(x + cols.done / 2 - 6, y + rowH / 2 - 6, 12, 12).lineWidth(0.8).strokeColor('#9aa3b5').stroke();
    y += rowH;
    doc.moveTo(MARGIN_X, y).lineTo(MARGIN_X + CONTENT_W, y).lineWidth(0.5).strokeColor(RULE).stroke();
  });
  return y + 16;
}

// ── Footer on every page ──────────────────────────────────────────────────────
function addFooters(doc: Doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Drawn inside the bottom margin: lift the margin so writing there doesn't add a page.
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(MARGIN_X, PAGE_H - 44).lineTo(MARGIN_X + CONTENT_W, PAGE_H - 44).lineWidth(0.4).strokeColor(RULE).stroke();
    spaced(doc, 'CognIX AI  ·  Meeting Intelligence Report', MARGIN_X, PAGE_H - 36, { font: SERIF, size: 8, color: MUTED, spacing: 0.4, width: 300 });
    spaced(doc, `Page ${i - range.start + 1} of ${range.count}`, MARGIN_X + CONTENT_W - 120, PAGE_H - 36, { font: SERIF, size: 8, color: MUTED, width: 120, align: 'right' });
    doc.page.margins.bottom = saved;
  }
}
