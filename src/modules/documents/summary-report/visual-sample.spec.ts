import { writeFileSync } from 'fs';
import { sampleReport } from './summary-report.fixture';
import { renderSummaryReportDocx } from './summary-report.docx';
import { renderSummaryReportPdf } from './summary-report.pdf';

const out = process.env.SAMPLE_OUT_DIR;
(out ? it : it.skip)('writes sample PDF and DOCX files for visual review', async () => {
  writeFileSync(`${out}/sample.pdf`, await renderSummaryReportPdf(sampleReport()));
  writeFileSync(`${out}/sample.docx`, await renderSummaryReportDocx(sampleReport()));
});
