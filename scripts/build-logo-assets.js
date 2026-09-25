/**
 * One-off generator for the document logo / watermark PNGs in src/assets.
 * Knocks the off-white background out of the source logo and writes:
 *   cognix-logo.png       – transparent logo for document headers
 *   cognix-watermark.png  – same logo at low opacity for page watermarks
 *
 * Usage: node scripts/build-logo-assets.js <source-logo.png>
 * (@napi-rs/canvas is only needed here, not at runtime.)
 */
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const OUT = path.join(__dirname, '..', 'src', 'assets');

async function build(src, outName, opacity, width) {
  const img = await loadImage(src);
  const w = width;
  const h = Math.round((img.height / img.width) * w);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < data.data.length; i += 4) {
    const min = Math.min(data.data[i], data.data[i + 1], data.data[i + 2]);
    // soft ramp: >=245 fully transparent, <=200 fully opaque
    const a = Math.max(0, Math.min(1, (245 - min) / 45));
    data.data[i + 3] = Math.round(a * 255 * opacity);
  }
  ctx.putImageData(data, 0, 0);
  fs.writeFileSync(path.join(OUT, outName), canvas.toBuffer('image/png'));
}

(async () => {
  const src = process.argv[2];
  if (!src) throw new Error('Usage: node scripts/build-logo-assets.js <source-logo.png>');
  await build(src, 'cognix-logo.png', 1, 600);
  await build(src, 'cognix-watermark.png', 0.1, 700);
})();
