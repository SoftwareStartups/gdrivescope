#!/usr/bin/env bun
// Generate a minimal hand-rolled PDF with a known text phrase so the
// kreuzberg spike has a deterministic, publication-safe fixture.
// PDF 1.4, 5 objects, single page, Helvetica, fixed xref.

import { fileURLToPath } from 'node:url';

const TEXT = 'Hello from gdrivescope spike fixture. Kreuzberg, read me.';

function makePdf(text: string): Uint8Array {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
  const parts: string[] = [];
  const offsets: number[] = [];
  let cursor = 0;

  const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  parts.push(header);
  cursor += Buffer.byteLength(header, 'binary');

  const addObject = (body: string): void => {
    offsets.push(cursor);
    parts.push(body);
    cursor += Buffer.byteLength(body, 'binary');
  };

  addObject('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  addObject('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  addObject(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n'
  );
  addObject(
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'binary')} >>\nstream\n${stream}endstream\nendobj\n`
  );
  addObject(
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  );

  const xrefStart = cursor;
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) {
    xref += `${o.toString().padStart(10, '0')} 00000 n \n`;
  }
  parts.push(xref);

  const trailer = `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  parts.push(trailer);

  return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p, 'binary'))));
}

const pdf = makePdf(TEXT);
const outPath = fileURLToPath(new URL('./sample.pdf', import.meta.url));
await Bun.write(outPath, pdf);
process.stderr.write(`wrote ${outPath} (${pdf.byteLength} bytes)\n`);
