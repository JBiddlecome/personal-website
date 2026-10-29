// The Assembler: plain code lays out the PDF. No AI: page layout is a rule, not a judgment call.
const path = require('path');
const PDFDocument = require('pdfkit');
const store = require('./store');

const PAGE = 720;              // 10 x 10 inches, in points
const PICTURE_H = PAGE * 0.75; // pictures are 4:3
const MARGIN = 43;
const PAPER = '#faf5eb';
const INK = '#3c2d23';
const FONTS = path.join(__dirname, 'fonts');

// Print text centered in a box, shrinking the font until it fits.
function fitText(doc, text, font, x, y, w, h, maxSize, minSize) {
  let size = maxSize;
  doc.font(font);
  for (; size > minSize; size--) {
    doc.fontSize(size);
    if (doc.heightOfString(text, { width: w, align: 'center', lineGap: size * 0.3 }) <= h) break;
  }
  doc.fontSize(size);
  const blockH = doc.heightOfString(text, { width: w, align: 'center', lineGap: size * 0.3 });
  doc.fillColor(INK).text(text, x, y + Math.max(0, (h - blockH) / 2), { width: w, align: 'center', lineGap: size * 0.3 });
}

function newPage(doc) {
  doc.addPage({ size: [PAGE, PAGE], margin: 0 });
  doc.rect(0, 0, PAGE, PAGE).fill(PAPER);
}

async function assemble(bookId, story) {
  const doc = new PDFDocument({ autoFirstPage: false, info: { Title: story.title, Author: 'Storybook Agents' } });
  doc.registerFont('Body', path.join(FONTS, 'Andika-Regular.ttf'));
  doc.registerFont('Title', path.join(FONTS, 'PatrickHand-Regular.ttf'));
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', resolve));

  // Cover: title band above the cover picture.
  newPage(doc);
  const band = PAGE - PICTURE_H;
  fitText(doc, story.title, 'Title', MARGIN, 14, PAGE - 2 * MARGIN, band - 28, 54, 26);
  doc.image(await store.getImage(bookId, 'cover'), 0, band, { width: PAGE, height: PICTURE_H });

  // Story pages: picture on top, words underneath, page number at the bottom.
  for (const page of story.pages) {
    newPage(doc);
    const name = `page_${String(page.page_number).padStart(2, '0')}`;
    doc.image(await store.getImage(bookId, name), 0, 0, { width: PAGE, height: PICTURE_H });
    const top = PICTURE_H + 10;
    fitText(doc, page.text, 'Body', MARGIN, top, PAGE - 2 * MARGIN, PAGE - top - 30, 22, 11);
    doc.font('Body').fontSize(9).fillColor(INK).text(String(page.page_number), 0, PAGE - 22, { width: PAGE, align: 'center' });
  }

  newPage(doc);
  fitText(doc, 'The End', 'Title', 0, 0, PAGE, PAGE, 60, 60);

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

module.exports = { assemble };
