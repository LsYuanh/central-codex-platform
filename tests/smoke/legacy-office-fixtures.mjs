// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Apache POI test-data (Apache-2.0). Download explicitly; never trust a mutable branch.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, basename} from 'node:path';
export const revision = 'bf7c9b6a1490046517cbd8e1504e702a89be4bc9';
export const fixtures = [
  ['document/simple.doc', '4876e828e62d490fa188c7c4e47013e2e0dfdf02f5903dfd374bc0d2b2049ca1', [['Word 97-SR2']]],
  ['document/simple-table.doc', '67d7fe8e0555c16516354498a5935f24eeef90beb5efbf526f93a1d6c734da43', [['Cell 1,1', 'Cell 2,3', 'This text is below the table.']]],
  ['document/HeaderFooterUnicode.doc', '8bd7fc9552bccb7b71a0dc34ffd801e7d3547d1317fd75d0c35fca3572f6fa4b', [['€ euro symbol', 'The footer, with Molière', 'This is page two.']]],
  ['document/Word6.doc', '58ea3347378e85e7c8d19ad64e74ad533b2f51b30f047594b434f380712f8b50', [['The quick brown fox jumps over the lazy dog']]],
  ['spreadsheet/Simple.xls', '2b5ec8298bacffdca61c50f6f7607da0a4e63cf76fa011c62f203e6a66bc072a', [['replaceMe'], ['Sheet2'], ['Sheet3']]],
  ['spreadsheet/SimpleWithFormula.xls', '73a99975b9ad250669bd49ffe2223ed50df8324775acfbc612740d38827913c9', [['replacemereplaceme'], ['Sheet2'], ['Sheet3']]],
  ['slideshow/basic_test_ppt_file.ppt', 'e8fd4c38ad72ce3735acbca0b60dd5870fb60f819c169e3947d166f4f1bcc79d', [['This is a test title', 'These are the notes for page 1'], ['This is the title on page 2', 'These are the notes on page two']]],
  ['slideshow/with_textbox.ppt', '56a900d5784d9cc245c6580ea26b00ec7fd430d39c26ad5b5e2fc071a45a629d', [['Hello, World!!!', 'I am just a poor boy', 'This is Times New Roman', 'Plain Text']]],
  ['document/PasswordProtected.doc', '863d2216a6f5bb4cec0ea4131a05ae0822dbce347e2940155ef638c6d64935fe', null],
  ['spreadsheet/password.xls', '3ad12a829132d9c157d213c623af9c534b1449c42e93ab39b17ca53c909ac412', null],
  ['slideshow/Password_Protected-hello.ppt', '8d0dd9f53317a720687cf5234af0c021fab665194b09b9bb56a3f71b495bf45a', null],
];
export async function loadFixtures(download = false) {
  const root = resolve(process.env.QA_OFFICE_FIXTURES ?? 'target/office-acceptance');
  await mkdir(root, {recursive: true});
  const results = [];
  for (const [source, hash, sections] of fixtures) {
    const path = resolve(root, basename(source));
    let bytes;
    try { bytes = await readFile(path); } catch (error) {
      if (!download || error.code !== 'ENOENT') throw error;
      const response = await fetch(`https://raw.githubusercontent.com/apache/poi/${revision}/test-data/${source}`, {signal: AbortSignal.timeout(30000)});
      assert(response.ok, `Fixture download failed: ${source} (${response.status})`);
      bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, source);
      await writeFile(path, bytes);
    }
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, source);
    results.push({path, name: basename(source), hash, sections});
  }
  return results;
}
