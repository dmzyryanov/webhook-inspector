/**
 * Renders the three logo images the frontend serves as static files (issue
 * #69, D183) from `src/assets/qa-tools-mark.svg`, the existing mark: the mark
 * on a white square with even padding, so the navy ring stays visible on a
 * dark background.
 *
 * - `public/favicon-192.png`, 192 × 192: the icon a search engine shows beside
 *   a result, linked from `index.html` beside the SVG icon;
 * - `public/logo-512.png`, 512 × 512: the `og:image` of a link preview;
 * - `public/favicon.ico`, 16, 32 and 48 px: for a client that asks for
 *   `/favicon.ico` by name.
 *
 * Run by hand, once, and not by the build: the three files are committed.
 * Running it again after a change to the mark rewrites them. It draws in the
 * Chromium the browser suite already installs (`@playwright/test`, a root dev
 * dependency), so no image tool or further package is needed:
 *
 *   node apps/frontend/scripts/render-logo-images.mjs
 *
 * The mark's drawn extent is measured on a 2048 px rendering and centred in
 * the square, with PADDING of the side on each side of its longer dimension.
 * Each size is drawn from the vector at that size, not scaled from another.
 * The ICO holds three 32-bit BMP images, the form every reader of it accepts.
 */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { readFileSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import { chromium } from '@playwright/test';

const MARK = new URL('../src/assets/qa-tools-mark.svg', import.meta.url);
const PUBLIC = new URL('../public/', import.meta.url);

/** White space on each side of the mark's longer dimension, as a share of the side. */
const PADDING = 0.1;

const PNGS = { 'favicon-192.png': 192, 'logo-512.png': 512 };
const ICO_SIZES = [16, 32, 48];

/**
 * Runs in the page. Measures the mark, then draws it at every size on white;
 * answers each as a PNG and as raw RGBA, both in Base64.
 */
async function drawInPage({ svg, sizes, padding }) {
  const { document } = globalThis;
  const BOX = 512;
  const PROBE = 2048;
  const load = (text) =>
    new Promise((resolve, reject) => {
      const image = new globalThis.Image();

      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('the mark did not load'));
      image.src = `data:image/svg+xml;base64,${globalThis.btoa(text)}`;
    });
  const canvas = (size) => {
    const element = document.createElement('canvas');

    element.width = size;
    element.height = size;

    return element.getContext('2d', { willReadFrequently: true });
  };
  const base64 = (bytes) => {
    let text = '';

    for (const byte of bytes) {
      text += String.fromCharCode(byte);
    }

    return globalThis.btoa(text);
  };

  const probe = canvas(PROBE);

  probe.drawImage(await load(svg), 0, 0, PROBE, PROBE);

  const { data } = probe.getImageData(0, 0, PROBE, PROBE);
  let [left, top, right, bottom] = [PROBE, PROBE, -1, -1];

  for (let y = 0; y < PROBE; y += 1) {
    for (let x = 0; x < PROBE; x += 1) {
      if (data[(y * PROBE + x) * 4 + 3] > 0) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }

  const unit = PROBE / BOX;
  const extent = [left / unit, top / unit, (right + 1) / unit, (bottom + 1) / unit];
  const side = Math.max(extent[2] - extent[0], extent[3] - extent[1]) / (1 - 2 * padding);
  const x = (extent[0] + extent[2]) / 2 - side / 2;
  const y = (extent[1] + extent[3]) / 2 - side / 2;
  const images = [];

  for (const size of sizes) {
    const framed = svg
      .replace(
        'width="512" height="512" viewBox="0 0 512 512"',
        `width="${size}" height="${size}" viewBox="${x} ${y} ${side} ${side}"`,
      )
      .replace(
        /(<svg[^>]*>)/,
        `$1<rect x="${x}" y="${y}" width="${side}" height="${side}" fill="#ffffff"/>`,
      );
    const context = canvas(size);

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size, size);
    context.drawImage(await load(framed), 0, 0, size, size);

    images.push({
      size,
      png: context.canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''),
      rgba: base64(context.getImageData(0, 0, size, size).data),
    });
  }

  return { extent, side, images };
}

/** One image of an ICO: a 32-bit BMP, bottom-up, with an all-opaque mask. */
function icoBitmap(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);

  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  // The colour image and the mask stacked, as the format requires.
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20);

  const pixels = Buffer.alloc(size * size * 4);

  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const from = (row * size + column) * 4;
      const to = ((size - 1 - row) * size + column) * 4;

      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  }

  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

function ico(images) {
  const directory = Buffer.alloc(6 + 16 * images.length);
  const bitmaps = images.map(({ size, rgba }) => icoBitmap(size, rgba));
  let offset = directory.length;

  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);

  images.forEach(({ size }, index) => {
    const entry = 6 + 16 * index;

    directory.writeUInt8(size, entry);
    directory.writeUInt8(size, entry + 1);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(bitmaps[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += bitmaps[index].length;
  });

  return Buffer.concat([directory, ...bitmaps]);
}

const svg = readFileSync(MARK, 'utf8');

if (!svg.includes('width="512" height="512" viewBox="0 0 512 512"')) {
  throw new Error('qa-tools-mark.svg no longer opens with a 512 × 512 box; adjust this script');
}

const browser = await chromium.launch();

try {
  const page = await browser.newPage();
  const sizes = [...Object.values(PNGS), ...ICO_SIZES];
  const { extent, side, images } = await page.evaluate(drawInPage, {
    svg,
    sizes,
    padding: PADDING,
  });
  const bySize = new Map(images.map((image) => [image.size, image]));

  for (const [name, size] of Object.entries(PNGS)) {
    writeFileSync(new URL(name, PUBLIC), Buffer.from(bySize.get(size).png, 'base64'));
  }

  writeFileSync(
    new URL('favicon.ico', PUBLIC),
    ico(ICO_SIZES.map((size) => ({ size, rgba: Buffer.from(bySize.get(size).rgba, 'base64') }))),
  );

  console.log(
    `logo images: the mark's extent ${extent.map((value) => value.toFixed(2)).join(', ')} ` +
      `in a square of ${side.toFixed(2)}; wrote ${Object.keys(PNGS).join(', ')} and favicon.ico`,
  );
} finally {
  await browser.close();
}
