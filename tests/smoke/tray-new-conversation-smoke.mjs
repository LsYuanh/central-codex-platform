// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Frontend IPC regression; native tray/single-instance lifecycle also requires Windows/macOS QA.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? 'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const built = await build({ entryPoints: ['tests/fixtures/tray-new-conversation-qa.tsx'], bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic' });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: built.outputFiles[0].text });
  await page.waitForFunction(() => window.trayQa.enabled);
  await page.evaluate(() => window.fireTray());
  assert.deepEqual(await page.evaluate(() => window.trayQa.opened), ['原草稿'], 'StrictMode must leave exactly one listener');
  await page.getByRole('textbox', { name: '草稿' }).fill('最新草稿');
  await page.evaluate(() => window.fireTray());
  assert.deepEqual(await page.evaluate(() => window.trayQa.opened), ['原草稿', '最新草稿'], 'native listener must use current state');
  await page.getByRole('button', { name: '切换可用' }).click();
  await page.waitForFunction(() => !window.trayQa.enabled);
  await page.evaluate(() => window.fireTray());
  assert.equal(await page.evaluate(() => window.trayQa.opened.length), 2, 'late event cannot bypass busy guard');
  await page.getByRole('button', { name: '切换可用' }).click();
  await page.waitForFunction(() => window.trayQa.enabled);
  await page.getByRole('button', { name: '切换挂载' }).click();
  await page.evaluate(() => window.fireTray());
  assert.equal(await page.evaluate(() => window.trayQa.opened.length), 2, 'unmounted listener must be removed');
  await page.getByRole('button', { name: '切换挂载' }).click();
  await page.waitForFunction(() => window.trayQa.enabled);
  await page.evaluate(() => window.fireTray());
  assert.equal(await page.evaluate(() => window.trayQa.opened.length), 3);
  await page.evaluate(() => { window.trayQa.fail = true; });
  await page.getByRole('button', { name: '切换可用' }).click();
  await page.getByRole('alert').filter({ hasText: '托盘菜单更新失败' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('TRAY_FRONTEND_OK: registration, latest draft, busy guard, cleanup, remount, explicit IPC error');
} finally { await browser.close(); }
