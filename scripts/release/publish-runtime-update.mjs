// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Invoked only in the protected signing/release job after builder validation.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {publishRuntimeUpdate} from './runtime-publisher.mjs';
if(!process.argv[2])throw Error('Usage: node scripts/release/publish-runtime-update.mjs CANDIDATE_DIRECTORY');
const channelKey=JSON.parse(await readFile(new URL('../../harness/runtime-update-channel.json',import.meta.url))).publicKey;
console.log(JSON.stringify(await publishRuntimeUpdate(resolve(process.argv[2]),{channelKey})));
