// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {dirname, resolve} from 'node:path';
import {devNull} from 'node:os';
export function isolatedGitEnvironment(source) {
  const env={...process.env};
  for(const name of Object.keys(env)) if(/^GIT_/i.test(name)) delete env[name];
  Object.assign(env,{GIT_CEILING_DIRECTORIES:dirname(resolve(source)),
    GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':devNull,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
  return env;
}
