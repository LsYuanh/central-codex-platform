// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { localAgentExecutable } from './client-smoke-platform.mjs';

// Native mode requires a development binary built with an isolated TAURI_CONFIG identifier.
const native = process.argv.includes('--native');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? 'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
await mkdir('target', { recursive: true });
const output = await mkdtemp(resolve('target/markdown-ui-'));
const source = resolve('apps/desktop/src').replaceAll('\\', '/');
const fixture = `# 多格式回复

这是 **粗体与 *斜体***、~~删除线~~ 和 \`inline_code\`。转义：\\*星号\\*。
保持普通消息的换行。

| 核对项 | 登记资料 | 方案标准 |
| :--- | :---: | ---: |
| 年龄 | **至少 18 岁** | 18–65 岁 |
| 内容 | 含转义竖线 a\\|b | 右对齐 |

> 引用说明
>
> > 第二层引用

3. 第三项
   - 子项目
     - 更深一层
4. 第四项

- [x] 已完成
- [ ] 待核对

---

[官网][home]、https://example.com/very/long/path 和注释[^one]。

[home]: https://example.com
[^one]: 脚注正文，支持 **强调**。

行内公式 $E=mc^2$。

$$
\\frac{a+b}{2} + \\begin{pmatrix}1 & 0 \\\\ 0 & 1\\end{pmatrix}
$$

\`\`\`typescript
const greeting: string = "你好";
console.log(greeting);
\`\`\`

\`\`\`powershell
Get-ChildItem -Path 'C:\\Workplace'
\`\`\`

\`\`\`mermaid
flowchart LR
  A[需求] --> B[确认方案] --> C[实施验证]
\`\`\`

![示例图片](https://example.invalid/fixture.png "正文图片说明")

<script>window.markdownExecuted=true</script>
`;
await writeFile(join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="./fixture.tsx"></script></html>');
await writeFile(join(output, 'fixture.tsx'), `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{MarkdownMessage}from'${source}/MarkdownMessage.tsx';import '${source}/styles.css';
const initial=${JSON.stringify(fixture)};
document.documentElement.dataset.theme='light';document.body.style.background='var(--canvas)';document.body.style.overflow='auto';document.body.style.height='auto';document.body.style.minHeight='100vh';
function Fixture(){const[state,setState]=useState({content:initial,streaming:false,images:[]});window.renderMarkdown=next=>setState({streaming:false,images:[],...next});return <main style={{maxWidth:760,margin:'0 auto',padding:20,width:'100%',boxSizing:'border-box'}}><article id="primary" className="chat-bubble bubble-assistant"><div className="bubble-content"><MarkdownMessage {...state}/></div></article><article id="second" className="chat-bubble"><MarkdownMessage content={'重复注释[^one]\\n\\n[^one]: 第二条消息的注释'}/></article></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`);
const server = await createServer({ configFile: false, root: output, plugins: [react()], cacheDir: join(output, '.vite'), server: { host: '127.0.0.1', port: native ? 1420 : 0, strictPort: native, fs: { allow: [resolve('.')] } } });
await server.listen();
let child, browser, agent;
try {
  if (native) {
    assert(process.env.MARKDOWN_NATIVE_EXE, 'Set MARKDOWN_NATIVE_EXE to an isolated QA development binary');
    // Only the message component is under test. Never inherit legacy development
    // defaults that could start a sidecar or attempt a central connection.
    child = spawn(process.env.MARKDOWN_NATIVE_EXE, [], { windowsHide: true, env: { ...process.env,
      CODEXIA_WORKSPACE_ROOT: output, CODEXIA_GATEWAY_AGENT_URL: 'ws://127.0.0.1:9/ws/agent',
      CODEXIA_LOCAL_AGENT_PATH: join(output, 'render-only-no-sidecar.exe'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9224' }, stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:9224'); break; } catch { await delay(500); }
    }
    assert(browser, 'QA WebView must expose its debugging endpoint');
  } else browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = native ? browser.contexts().flatMap(c => c.pages())[0] : await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('https://example.invalid/fixture.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64') }));
  await page.goto(server.resolvedUrls.local[0]);
  const primary = page.locator('#primary');
  await primary.locator('table').waitFor();
  assert.equal(await primary.locator('th').count(), 3);
  assert.equal(await primary.locator('tbody tr').count(), 2);
  assert.equal(await primary.locator('tbody tr').first().locator('td').last().evaluate(el => getComputedStyle(el).textAlign), 'right');
  assert.equal(await primary.locator('blockquote blockquote').count(), 1);
  assert.equal(await primary.locator('ol[start="3"] ul ul').count(), 1);
  assert.equal(await primary.locator('input[type="checkbox"]:disabled').count(), 2);
  assert.equal(await primary.locator('input:checked').count(), 1);
  assert.equal(await primary.locator('strong em').count(), 1);
  assert.equal(await primary.locator('del').innerText(), '删除线');
  await primary.locator('.katex').first().waitFor({ timeout: 30000 });
  assert.equal(await primary.locator('.katex').count(), 2);
  await primary.locator('.hljs-keyword').first().waitFor();
  await primary.locator('.markdown-diagram img').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#primary img')].every(img => img.complete && img.naturalWidth > 0));
  await page.clock.install();
  await page.clock.fastForward(16_000);
  assert.equal(await primary.locator('.markdown-image-status').count(), 0, 'loaded images must cancel their deadline');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedMarkdown = text; } } }));
  await primary.getByRole('button', { name: '复制', exact: true }).first().click();
  assert.equal(await page.evaluate(() => window.copiedMarkdown), 'const greeting: string = "你好";\nconsole.log(greeting);');
  await page.clock.fastForward(2100);
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('test copy denied'); }; });
  await primary.getByRole('button', { name: '复制', exact: true }).first().click();
  await primary.getByRole('button', { name: '复制失败，请重试' }).waitFor();
  await page.clock.fastForward(2100);
  assert.equal(await page.evaluate(() => window.markdownExecuted), undefined);
  assert.equal(await primary.locator('script').count(), 0);
  const ids = await page.locator('[id]').evaluateAll(nodes => nodes.map(n => n.id));
  assert.equal(new Set(ids).size, ids.length, 'footnote IDs must not collide across messages');
  await primary.locator('a[data-footnote-ref]').click();
  assert(await primary.locator('.footnotes li').evaluate(el => el === document.activeElement), 'footnote moves focus within the message');
  await primary.locator('a[data-footnote-backref]').click();
  assert(await primary.locator('a[data-footnote-ref]').evaluate(el => el === document.activeElement));
  await page.screenshot({ path: join(output, 'light.png'), fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await primary.locator('.markdown-diagram img').waitFor();
  await page.screenshot({ path: join(output, 'dark.png'), fullPage: true });
  await page.setViewportSize({ width: 400, height: 900 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow viewport must not overflow horizontally');
  await page.screenshot({ path: join(output, 'narrow.png'), fullPage: true });

  const render = async (content, rest = {}) => { await page.evaluate(args => window.renderMarkdown(args), { content, ...rest }); await delay(120); };
  await render('```mermaid\nflowchart LR\nA -->', { streaming: true });
  assert((await primary.innerText()).includes('图表生成中'));
  assert.equal(await primary.locator('.markdown-diagram img').count(), 0);
  await render('```mermaid\nflowchart LR\nA --> B\n```');
  await primary.locator('.markdown-diagram img').waitFor();
  await render('```mermaid\nthis is not a diagram\n```');
  await page.waitForFunction(() => document.querySelector('#primary').textContent.includes('图表无法显示'));
  assert((await primary.locator('pre').innerText()).includes('this is not a diagram'));
  await render('$$\n\\notARealCommand{\n$$');
  await page.waitForFunction(() => document.querySelector('#primary').textContent.includes('公式无法显示'));
  await render('![无效](javascript:alert(1))\n\n[危险](javascript:alert(1))\n\n![本机](C:/unknown.png)');
  assert.equal(await primary.locator('img').count(), 0);
  assert.equal(await primary.locator('a[href^="javascript"]').count(), 0);
  assert((await primary.innerText()).includes('图片未关联本机附件'));
  await render('![失效图片](https://example.invalid/missing.png)');
  await page.route('https://example.invalid/missing.png', route => route.abort());
  await primary.getByRole('button', { name: '重试' }).waitFor();
  await page.route('https://example.invalid/slow.png', () => {});
  await render('![超时图片](https://example.invalid/slow.png)');
  await page.clock.fastForward(16_000);
  assert((await primary.innerText()).includes('图片加载超时'));
  await render('| 表头 | 数值 |\n| --- | --- |\n| 内容 | 42 |', { streaming: true });
  assert.equal(await primary.locator('tbody td').count(), 2);
  await render('```text\n<iframe src="https://example.com"></iframe>\n```');
  assert.equal(await primary.locator('iframe').count(), 0);
  assert.equal(await primary.locator('pre').innerText(), '<iframe src="https://example.com"></iframe>');
  // Exercise browser -> existing attachment API -> real local Agent IPC on test files.
  // This is not a central/model connection test, nor a mocked successful file read.
  if (!native) {
    const pngPath = join(output, 'agent-image.png');
    const imageBytes = await readFile('apps/desktop/src-tauri/icons/icon.png');
    await writeFile(pngPath, imageBytes);
    agent = spawn(localAgentExecutable(), ['--workspace-root', output, '--gateway-url', 'ws://127.0.0.1:9/ws/agent', '--attachment-stdio'], { windowsHide: true, stdio: ['pipe','pipe','ignore'], env: { ...process.env, LOCALAPPDATA: output } });
    let next = 0; const pending = new Map(); const calls = [];
    createInterface({ input: agent.stdout }).on('line', line => { const reply = JSON.parse(line); const callback = pending.get(reply.id); if (callback) { pending.delete(reply.id); reply.ok ? callback.resolve(reply.result) : callback.reject(new Error(reply.error)); } });
    const ipc = (method, params = {}) => new Promise((resolve, reject) => { const id = String(++next); const timer = setTimeout(() => { pending.delete(id); reject(new Error('Agent IPC timeout')); }, 5000); pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } }); calls.push(method); agent.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
    const identity = await ipc('attachment/identity'); const stat = await ipc('file/stat', { path: pngPath });
    const reference = { ...stat, id: 'image-fixture', source: 'localFile', deviceId: identity.deviceId, state: 'read' };
    await page.exposeFunction('agentImageRequest', (command, args) => { assert.equal(command, 'attachment_request'); return ipc(args.method, args.params); });
    await page.evaluate(() => { window.isTauri = true; window.__TAURI_INTERNALS__ = { invoke: window.agentImageRequest }; });
    const content = `![本机图片](<${pngPath.replaceAll('\\','/')}>)`;
    await render(content, { images: [reference] });
    await page.waitForFunction(() => document.querySelector('#primary img')?.naturalWidth > 0);
    assert(calls.includes('attachment/preview'));
    // Device mismatch must stop before any preview call.
    const count = calls.filter(method => method === 'attachment/preview').length;
    await render(content, { images: [{ ...reference, deviceId: 'different-device' }] });
    await page.waitForFunction(() => document.querySelector('#primary').textContent.includes('请在来源设备'));
    assert.equal(calls.filter(method => method === 'attachment/preview').length, count);
    await writeFile(pngPath, Buffer.concat([imageBytes, Buffer.from([0])]));
    await render(content, { images: [reference] });
    await page.waitForFunction(() => document.querySelector('#primary .markdown-image-status button'));
    assert.equal(await primary.locator('img').count(), 0, 'changed source version cannot display stale image');
    const fresh = await ipc('file/stat', { path: pngPath });
    const saved = { ...fresh, id: 'output-fixture', threadId: 'fixture', source: 'deviceFile', deviceId: identity.deviceId, deviceKey: identity.deviceKey, status: 'saved' };
    await render(content, { images: [saved] });
    await page.waitForFunction(() => document.querySelector('#primary img')?.naturalWidth > 0);
    assert(calls.includes('attachment/output_preview'));
    await render(content, { images: [{ ...saved, deviceKey: 'wrong-installation' }] });
    await page.waitForFunction(() => document.querySelector('#primary').textContent.includes('请在来源设备'));
    await page.evaluate(() => { delete window.isTauri; delete window.__TAURI_INTERNALS__; });
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'result.json'), JSON.stringify({ native, passed: true, localAgentImages: !native, scenarios: ['GFM','nested content','scoped footnotes','math','highlight','Mermaid','streaming','invalid syntax','images','timeouts','copy success/failure (mock clipboard)','raw HTML','themes','400px'] }, null, 2));
  console.log(`MARKDOWN_UI_OK ${native ? 'TAURI' : 'BROWSER'} ${output}`);
} finally { await browser?.close(); if (child) child.kill(); agent?.kill(); await server.close(); }
