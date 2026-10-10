// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {loadPlaywright} from '../support/playwright.mjs';
// Explicitly targets a running development WebView. Sends no model task, saves no settings.
// Covers real Tauri event delivery/navigation; OS tray clicks are a separate manual check.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const endpoint = process.argv[2];
assert(endpoint, 'Pass the development WebView CDP endpoint');
const {chromium}=await loadPlaywright();
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('127.0.0.1:1420'));
  assert(page, 'Requires the existing desktop Vite development entry');
  const fire = () => page.evaluate(async () => {
    await window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', {
      target: { kind: 'AnyLabel', label: 'main' }, event: 'desktop-new-conversation', payload: null,
    });
  });
  if (await page.getByRole('button', { name: '设置', exact: true }).isVisible()) await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '常规与连接', exact: true }).click();
  const directory = page.getByRole('textbox', { name: '默认输出目录', exact: true });
  const original = await directory.inputValue();
  try {
    await directory.fill(original + '-tray-unsaved');
    await fire();
    const dialog = page.getByRole('dialog', { name: '连接配置尚未保存' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
    assert.equal(await directory.inputValue(), original + '-tray-unsaved');
    await fire();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '放弃修改', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('header')?.textContent === '新对话');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '发送消息');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '常规与连接', exact: true }).click();
    assert.equal(await directory.inputValue(), original, 'discard must restore saved directory');
    await fire();
    await page.waitForFunction(() => document.querySelector('header')?.textContent === '新对话');
  } finally {
    if (await directory.isVisible()) await directory.fill(original);
  }
  console.log('TRAY_NATIVE_UI_OK: actual targeted IPC, unsaved guard, continue editing, discard, settings navigation, composer focus');
} finally { await browser.close(); }
