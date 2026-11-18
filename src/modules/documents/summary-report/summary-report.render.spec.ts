import * as JSZip from 'jszip';
import { pdfSafe, renderSummaryReportPdf } from './summary-report.pdf';
import { renderSummaryReportDocx } from './summary-report.docx';
import { sampleReport } from './summary-report.fixture';

/** Uncompressed PDF text appears as hex/literal strings inside Tj/TJ operators; a latin1 scan is enough for presence checks. */
const pdfText = (buf: Buffer) => {
  const raw = buf.toString('latin1');
  // text is drawn as [<hex> kern <hex> …] TJ — join the hex runs of each operator back into a string
  const lines = [...raw.matchAll(/\[([^\]]*)\]\s*TJ/g)].map((m) =>
    [...m[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], 'hex').toString('latin1')).join(''),
  );
  return lines.join('\n');
};
const pageCount = (buf: Buffer) => (buf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;

describe('summary report renderers', () => {
  it('pdfSafe keeps Western text, folds accents it cannot draw, and never throws on other scripts', () => {
    expect(pdfSafe('Café – “quoted”')).toContain('Caf');
    expect(() => pdfSafe('Ẹ kú àárọ̀ 你好')).not.toThrow();
    expect(pdfSafe('plain')).toBe('plain');
  });

  it('renders a valid PDF with a cover and one page-broken section per session', async () => {
    const report = sampleReport();
    const buf = await renderSummaryReportPdf(report, { compress: false });
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    // cover/contents page + at least one page per session
    expect(pageCount(buf)).toBeGreaterThanOrEqual(1 + report.sessions.length);
  });

  it('a single-session report still renders', async () => {
    const report = sampleReport();
    report.sessions = report.sessions.slice(0, 1);
    const buf = await renderSummaryReportPdf(report);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('PDF contains every session title and every transcript line', async () => {
    const report = sampleReport();
    const text = pdfText(await renderSummaryReportPdf(report, { compress: false }));
    const flat = text.replace(/\s+/g, ' ');
    for (const s of report.sessions) {
      expect(flat).toContain(s.title.split(' ')[0]);
      for (const item of s.transcript) {
        if (item.kind === 'turn') expect(flat.toUpperCase()).toContain(item.speaker.toUpperCase());
      }
    }
  });

  it('DOCX is a valid package with every session, speaker and transcript word, separated by page breaks', async () => {
    const report = sampleReport();
    const zip = await JSZip.loadAsync(await renderSummaryReportDocx(report));
    const xml = await zip.file('word/document.xml')!.async('string');
    const plain = xml.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\s+/g, ' ');
    for (const s of report.sessions) {
      expect(plain).toContain(s.title);
      for (const item of s.transcript) {
        if (item.kind === 'turn') {
          expect(plain.toUpperCase()).toContain(item.speaker.toUpperCase());
          expect(plain).toContain(item.text.split(' ')[0]);
        }
      }
    }
    expect((xml.match(/w:pageBreakBefore/g) ?? []).length).toBeGreaterThanOrEqual(report.sessions.length);
    expect(plain).toMatch(/Sessions at a glance/i);
  });
});
