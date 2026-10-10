// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Read-only heuristic audit. Findings contain locations, never matched values.
import {execFileSync} from 'node:child_process';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const git = args => execFileSync('git', ['-c', 'core.quotepath=false', ...args], {maxBuffer: 256 * 1024 * 1024, windowsHide: true});
const rules = {
  'private-key': /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g,
  'provider-token': /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16})/g,
  jwt: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{15,}/g,
  'pairing-bundle': /yzpair1\.[A-Za-z0-9_-]{70,}/g,
  'home-directory': /(?:[A-Z]:[\\/]+Users[\\/]+[^\\/\s"'`]+|\/Users\/[^/\s"'`]+)/g,
  'private-network': /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
  'literal-secret': /(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|device[_-]?token|private[_-]?key)\s*["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/gi,
};
// A local clone may intentionally retain private stash/worktree/remote refs.
// Audit only the refs intended for publication when checking a rewrite.
const publishableHistory = process.argv.includes('--publishable-history');
const history = publishableHistory || process.argv.includes('--history');
const historyRefs = publishableHistory ? ['--branches', '--tags'] : ['--all'];
const findings = [];
let scanned = 0, binarySkipped = 0;
function scan(bytes, location) {
  if (bytes.includes(0)) { binarySkipped++; return; }
  scanned++;
  const text = bytes.toString('utf8');
  for (const [category, re] of Object.entries(rules)) {
    for (const match of text.matchAll(re)) {
      findings.push({...location, category, line: text.slice(0, match.index).split('\n').length});
    }
  }
}
const tracked = git(['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
for (const file of tracked) scan(readFileSync(file), {scope: 'worktree', file});
let commits = 0, objects = 0;
if (history) {
  commits = Number(git(['rev-list', '--count', ...historyRefs]).toString().trim());
  const entries = git(['rev-list', '--objects', ...historyRefs]).toString('utf8').trim().split('\n').map(line => {
    const space = line.indexOf(' ');
    return {id: space < 0 ? line : line.slice(0, space), file: space < 0 ? undefined : line.slice(space + 1)};
  });
  const input = entries.map(x => x.id).join('\n') + '\n';
  // Batch reads scan each reachable object once, including commit/tag messages.
  const data = execFileSync('git', ['cat-file', '--batch'], {input, maxBuffer: 256 * 1024 * 1024, windowsHide: true});
  let offset = 0;
  for (const entry of entries) {
    const end = data.indexOf(10, offset);
    const [id, type, sizeText] = data.subarray(offset, end).toString().split(' ');
    const size = Number(sizeText);
    if (id !== entry.id || !Number.isFinite(size)) throw Error('GIT_OBJECT_READ_FAILED');
    offset = end + 1;
    if (['blob', 'commit', 'tag'].includes(type)) {
      scan(data.subarray(offset, offset + size), {scope: 'history', object: id, type, file: entry.file});
      objects++;
    }
    offset += size + 1;
  }
}
const counts = {};
for (const f of findings) counts[`${f.scope}:${f.category}`] = (counts[`${f.scope}:${f.category}`] ?? 0) + 1;
const report = {heuristicOnly: true, historyScope: history ? (publishableHistory ? 'branches-and-tags' : 'all-local-refs') : null, trackedFiles: tracked.length, commits, objects, scanned, binarySkipped, counts, findings};
const output = path.resolve('artifacts/open-source-private', publishableHistory ? 'publishable-history-audit.json' : history ? 'history-audit.json' : 'worktree-audit.json');
mkdirSync(path.dirname(output), {recursive: true});
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({...report, findings: undefined, output: path.relative(process.cwd(), output)}));
