#!/usr/bin/env node
// render-lottie.mjs <lottie-json-path> <out-dir> [max-frames]
// Loads Lottie JSON in headless chromium via puppeteer-core + lottie-web,
// snapshots each frame to PNG.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));

const [, , jsonPath, outDir, maxFramesArg] = process.argv;
if (!jsonPath || !outDir) {
  console.error('usage: render-lottie.mjs <lottie-json> <out-dir> [max-frames]');
  process.exit(2);
}
const MAX_FRAMES = Number(maxFramesArg) || 60;

const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
// Lottie schema: w, h, ip (in-point frame), op (out-point frame), fr (fps)
const width = Math.max(1, json.w || 512);
const height = Math.max(1, json.h || 512);
const ip = json.ip ?? 0;
const op = json.op ?? 60;
const totalFrames = Math.max(1, Math.ceil(op - ip));
const frameCount = Math.min(MAX_FRAMES, totalFrames);

const htmlUrl = pathToFileURL(join(__dirname, 'lottie.html')).href;

const browser = await puppeteer.launch({
  executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH || '/usr/bin/chromium',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(htmlUrl, { waitUntil: 'load' });

  await page.evaluate((animData, w, h) => {
    window._loadLottie(animData, w, h);
  }, json, width, height);

  const outAbs = resolve(outDir);
  for (let i = 0; i < frameCount; i++) {
    const animationFrame = ip + (i / Math.max(1, frameCount - 1)) * (op - ip - 1);
    await page.evaluate((f) => window._goToFrame(f), animationFrame);
    const idx = String(i + 1).padStart(3, '0');
    await page.screenshot({
      path: join(outAbs, `frame_${idx}.png`),
      omitBackground: true,
      clip: { x: 0, y: 0, width, height },
    });
  }
} finally {
  await browser.close();
}
