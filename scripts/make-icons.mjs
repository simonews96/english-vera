// Renders the app icons from an inline SVG with the local Chromium (no image libraries needed).

import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const svg = (size, pad) => {
  const inner = size - pad * 2;
  const step = inner / 6;
  const lines = [];
  for (let i = 1; i <= 5; i += 1) {
    const x = pad + step * i;
    lines.push(`<line x1="${x}" y1="${pad + step * 0.6}" x2="${x}" y2="${size - pad - step * 0.6}"/>`);
  }
  const weft = [
    [1.6, 6],
    [2.6, 4.2],
    [3.6, 5.2],
    [4.4, 3.4],
  ].map(
    ([y, len]) =>
      `<line x1="${pad + step * 0.6}" y1="${pad + step * y}" x2="${pad + step * 0.6 + step * (len - 0.6)}" y2="${pad + step * y}"/>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#14171A"/>
  <g stroke="#E9ECEA" stroke-width="${Math.max(2, size / 64)}" stroke-linecap="square">${lines.join("")}</g>
  <g stroke="#9FB4E8" stroke-width="${Math.max(4, size / 24)}" stroke-linecap="square">${weft.join("")}</g>
</svg>`;
};

const targets = [
  ["public/icons/icon-192.png", 192, 20],
  ["public/icons/icon-512.png", 512, 54],
  ["public/icons/icon-maskable-512.png", 512, 110],
  ["public/apple-touch-icon.png", 180, 20],
];

const browser = await chromium.launch();
const page = await browser.newPage();
await mkdir("public/icons", { recursive: true });
for (const [file, size, pad] of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg(size, pad)}</body></html>`);
  const buffer = await page.screenshot({
    clip: { x: 0, y: 0, width: size, height: size },
    omitBackground: false,
  });
  await writeFile(file, buffer);
  console.log("wrote", file, buffer.length, "bytes");
}
await browser.close();
