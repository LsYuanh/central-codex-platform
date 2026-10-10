// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Installed project dependency by default; an explicit module path remains
// available for existing developer environments and isolated native QA.
export async function loadPlaywright(override = process.env.PLAYWRIGHT_MODULE) {
  return override ? import(pathToFileURL(path.resolve(override)).href) : import('playwright');
}
