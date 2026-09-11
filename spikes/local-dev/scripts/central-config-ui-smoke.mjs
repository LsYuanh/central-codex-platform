// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Browser interaction regression with synthetic IPC; never contacts a gateway.
// Pass an absolute Playwright module path when it is provided by the host runtime.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const {chromium} = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'apps/central/dist');
const server = createServer(async (req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(dist, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(dist + path.sep)) { res.writeHead(403).end(); return; }
  try { res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({channel: 'msedge', headless: true});
  const page = await browser.newPage({viewport: {width: 1280, height: 1000}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.isTauri = true;
    window.fixture = {state: 'running', rejectSave: false, saves: 0};
    let config = {schemaVersion: 1, revision: 1, dataDirectory: '/Users/synthetic/central-data', listen: {host: '0.0.0.0', port: 14522}, clientUrl: 'wss://central.example:14522/ws', tls: {certificateId: 'synthetic-cert'}, runtimePackageId: 'synthetic-package', limits: {maxWorkers: 8, perUserTurns: 2, totalTurns: 8}, shutdown: {graceMs: 10000, forceMs: 5000}};
    window.__TAURI_INTERNALS__ = {invoke: async (cmd, args) => {
      if (cmd === 'central_ui_context') return {dataDirectory: config.dataDirectory, platform: 'darwin', runtimeAvailable: false, reason: 'synthetic'};
      if (cmd === 'central_config_read') return {initialized: true, config};
      if (cmd === 'central_config_validate') return {ok: true};
      if (cmd === 'central_config_save') {
        window.fixture.saves++;
        if (window.fixture.rejectSave) throw {code: 'SERVICE_ALREADY_ACTIVE'};
        config = {...args.config, revision: config.revision + 1}; return {config};
      }
      if (cmd === 'central_service_status') {
        if (window.fixture.state === 'unavailable') throw {code: 'OPERATION_TIMEOUT'};
        return {generation: 1, sequence: Date.now(), state: window.fixture.state, cleanupVerified: window.fixture.state === 'stopped', forcedStop: false};
      }
      if (cmd === 'central_service_context') return {candidateStartAvailable: true, needsAdmin: false, configRevision: config.revision};
      if (['central_runtime_catalog', 'central_tls_list', 'central_model_accounts_list'].includes(cmd)) return [];
      throw Error('unexpected fixture command: ' + cmd);
    }};
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', {name: '首次配置', exact: true}).click();
  await page.getByRole('button', {name: /下一步/}).click();
  await page.getByRole('button', {name: /下一步/}).click();
  const save = page.getByRole('button', {name: '保存本机配置', exact: true});
  await page.getByText(/当前使用已保存的配置/).waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(await page.evaluate(() => window.fixture.saves), 0);
  await mkdir(path.join(root, 'target/central-macos/config-ui'), {recursive: true});
  await page.screenshot({path: path.join(root, 'target/central-macos/config-ui/running.png'), fullPage: true});
  await page.evaluate(() => { window.fixture.state = 'stopped'; window.fixture.rejectSave = true; });
  await page.getByRole('button', {name: '刷新服务状态', exact: true}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '保存本机配置' && !b.disabled));
  await save.click();
  await page.getByText(/配置未保存。请到运行概览停止服务/).waitFor();
  assert.equal(await page.getByRole('button', {name: '核对上次保存结果'}).count(), 0);
  assert.equal(await save.isDisabled(), false, 'known rejection must not lock pending save');
  await page.getByRole('button', {name: '重新读取本机配置'}).click();
  await page.evaluate(() => { window.fixture.rejectSave = false; });
  await save.click();
  await page.getByText(/配置已保存到本机，版本 2/).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.saves), 2);
  await page.evaluate(() => { window.fixture.state = 'unavailable'; });
  await page.getByText(/服务状态尚未确认，暂不能保存配置/).waitFor({timeout: 10000});
  assert.equal(await save.isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log('CENTRAL_CONFIG_UI_SMOKE_OK running blocked; stopped enabled; rejected save recoverable; saved revision read back; failed status blocks save. Synthetic browser IPC only.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
