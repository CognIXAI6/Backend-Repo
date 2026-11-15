/**
 * Static guard (the repository has no ESLint): every logger call in non-test
 * source is parsed and its interpolated expressions are checked against terms
 * that identify a person, a document, a credential or biometric data.
 *
 * Logs may carry correlation ids, reason codes, counts and sizes. To log an
 * error from a provider/SDK use describeError(err); to log text use a length
 * or countWords(), never the text.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC = path.resolve(__dirname, '..');

/** Forbidden everywhere. */
const GLOBAL_FORBIDDEN: Array<[RegExp, string]> = [
  [/\bemail\b|\bemails\b|\boptions\.to\b|\.to\b/i, 'email address'],
  [/\b(downloadUrl|download_url|secure_url|signedUrl|fileUrl|file_url|audioUrl|acceptUrl)\b|\.url\b|\burl\b/i, 'URL'],
  [/\b(accessToken|refreshToken|token|jwt|apiKey|api_key|secret|password|authorization|bearer)\b/i, 'credential'],
  [/\btranscript\b|\buserMessage\b|\bprompt\b|\bpayload\.text\b|\btext\b/i, 'transcript/prompt text'],
  [/\b(similarity|similarityScore|voiceSpeakerId|voice_speaker_id|voiceId)\b|\bscore\b/i, 'biometric data'],
  [/\b(display_name|displayName|speakerName|resolvedName|speaker\.name|fieldName|filename|originalname|title)\b/i, 'name/title'],
];
/** Additionally forbidden in the voice/document flow, where account ids must not be logged. */
const STRICT_DIRS = ['modules/voice', 'modules/documents', 'modules/notifications', 'modules/upload', 'modules/email', 'modules/resources'];
const STRICT_FORBIDDEN: Array<[RegExp, string]> = [[/\b(userId|user\.id|session\.userId|accountId)\b/, 'account id']];

/** Expressions that are sizes/booleans/identifiers-of-counts and cannot carry content. */
const SAFE_SHAPES = [/^!/, /^Boolean\(/, /\.length\b/, /\.size\b/, /^countWords\(/, /^describeError\(/, /^redactText\(/, /^safePath\(/, /^safeHost\(/];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!['node_modules', 'database'].includes(entry.name)) walk(full, out); }
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function isLoggerCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!['log', 'warn', 'error', 'debug', 'verbose'].includes(callee.name.text)) return false;
  const target = callee.expression.getText();
  return /(^|\.)logger$/i.test(target) || /^(logger|Logger)$/.test(target);
}

function interpolations(node: ts.Node, out: ts.Expression[] = []): ts.Expression[] {
  if (ts.isTemplateExpression(node)) node.templateSpans.forEach((s) => out.push(s.expression));
  node.forEachChild((c) => { interpolations(c, out); }); // (a truthy return would stop the traversal)
  return out;
}

describe('log privacy (static)', () => {
  it('no logger call interpolates an email, URL, credential, transcript/prompt text, biometric data, person/document name or (in the voice flow) an account id', () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      const strict = STRICT_DIRS.some((d) => rel.startsWith(d));

      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && isLoggerCall(node)) {
          const exprs: ts.Expression[] = [];
          node.arguments.forEach((arg) => {
            interpolations(arg, exprs);
            // a bare identifier/property passed as an argument (e.g. logger.error('x', email))
            if (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) exprs.push(arg);
          });
          for (const expr of exprs) {
            const code = expr.getText(sf).trim();
            if (SAFE_SHAPES.some((re) => re.test(code))) continue;
            const rules = strict ? [...GLOBAL_FORBIDDEN, ...STRICT_FORBIDDEN] : GLOBAL_FORBIDDEN;
            for (const [re, what] of rules) {
              if (re.test(code)) {
                const { line } = sf.getLineAndCharacterOfPosition(expr.getStart(sf));
                violations.push(`${rel}:${line + 1}  logs ${what}: \${${code}}`);
              }
            }
          }
        }
        node.forEachChild((c) => { visit(c); });
      };
      visit(sf);
    }
    expect(violations).toEqual([]);
  });

  it('the scanner itself catches the violations the audit found', () => {
    const sample = ts.createSourceFile('x.ts', [
      'this.logger.log(`Attempting to send email to ${options.to}`);',
      'this.logger.log(`Transcript filtered: "${transcript}"`);',
      'this.logger.log(`Document ready: ${result.downloadUrl}`);',
      'this.logger.error(`usage failed for user ${session.userId}`);',
      'this.logger.log(`score=${result.similarityScore.toFixed(3)}`);',
      'this.logger.log(`words=${countWords(transcript)} empty=${!transcript} n=${items.length}`);',
    ].join('\n'), ts.ScriptTarget.Latest, true);
    const hits: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && isLoggerCall(node)) {
        for (const expr of interpolations(node)) {
          const code = expr.getText(sf2(sample)).trim();
          if (SAFE_SHAPES.some((re) => re.test(code))) continue;
          if ([...GLOBAL_FORBIDDEN, ...STRICT_FORBIDDEN].some(([re]) => re.test(code))) hits.push(code);
        }
      }
      node.forEachChild((c) => { visit(c); });
    };
    visit(sample);
    expect(hits).toEqual(['options.to', 'transcript', 'result.downloadUrl', 'session.userId', 'result.similarityScore.toFixed(3)']);
  });
});

function sf2(s: ts.SourceFile) { return s; }
