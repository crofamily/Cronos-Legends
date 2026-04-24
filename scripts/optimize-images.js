// One-off image optimizer: writes .webp siblings next to large source images
// used on the homepage. Run from repo root: node scripts/optimize-images.js
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// [src relative to repo, max side, webp quality]
const targets = [
  ['Images/Lyralogo1.png', 256, 82],
  ['Images/clg-logo.png', 256, 82],
  ['Images/tri-logo.png', 256, 82],
  ['Images/cara1.png', 1024, 80],
  ['Images/Lyra.jpg', 1024, 78],
  ['Images/trinari-logo.jpg', 1024, 78],
  ['Images/totem-collection.jpg', 1024, 78],
  ['Images/peace-collection.jpg', 1024, 78],
  ['Images/PreviewLAII/1.jpg', 1024, 78],
  ['Images/LA1/Horde Creatures (1).jpg', 1024, 78],
  ['Images/TrinariElderborn/T54.png', 1024, 80],
  ['Images/lyralogo3.png', 256, 82],
];

(async () => {
  let saved = 0;
  for (const [rel, maxSide, q] of targets) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) {
      console.log('SKIP missing:', rel);
      continue;
    }
    const dst = src.replace(/\.(png|jpg|jpeg)$/i, '.webp');
    const before = fs.statSync(src).size;
    await sharp(src)
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: q, effort: 5 })
      .toFile(dst);
    const after = fs.statSync(dst).size;
    saved += before - after;
    console.log(
      `${rel}  ${(before / 1024).toFixed(0)}KB -> ${(after / 1024).toFixed(0)}KB  (${Math.round(
        (1 - after / before) * 100
      )}%)`
    );
  }
  console.log(`\nTotal saved: ${(saved / 1024 / 1024).toFixed(2)} MB`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
