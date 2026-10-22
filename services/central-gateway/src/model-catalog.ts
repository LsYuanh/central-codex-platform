// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import http from 'node:http';
import https from 'node:https';
import {ModelTransportError} from './model-transport-error.js';

/** The version is the actual requesting runtime, never a fabricated latest version. */
export function catalogVersion(method: string | undefined, path: string | undefined): string | undefined {
  if (method !== 'GET') return;
  return /^\/v1\/models\?client_version=(\d{1,5}\.\d{1,5}\.\d{1,5})$/.exec(path ?? '')?.[1];
}

export async function fetchModelCatalog(url: URL, headers: Record<string, string>, signal: AbortSignal, agent:http.Agent|false=false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(Error('MODEL_CATALOG_UNAVAILABLE'));
    const transportFail = (error:unknown) => reject(new ModelTransportError('CATALOG',signal.aborted?signal.reason:error));
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      headers: {...headers, accept: 'application/json', 'accept-encoding': 'identity'}, signal, agent,
    }, response => {
      // Never follow redirects or forward upstream diagnostics to a Worker.
      if (response.statusCode !== 200 ||
          String(response.headers['content-type'] ?? '').split(';')[0] !== 'application/json' ||
          !['', 'identity'].includes(String(response.headers['content-encoding'] ?? ''))) {
        fail(); response.destroy(); return;
      }
      const chunks: Buffer[] = [];
      response.on('data', chunk => {
        chunks.push(Buffer.from(chunk));
      });
      response.once('error', transportFail);
      response.once('aborted', () => transportFail({code:'ECONNRESET'}));
      response.once('end', () => {
        try {
          const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
          const ids = new Set<string>();
          if (!Array.isArray(value.models) || !value.models.length) throw Error();
          for (const model of value.models) {
            if (!model || typeof model !== 'object' || typeof model.slug !== 'string' ||
                !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model.slug) || ids.has(model.slug) ||
                typeof model.display_name !== 'string' || !['list', 'hide'].includes(model.visibility) ||
                !Array.isArray(model.supported_reasoning_levels)) throw Error();
            ids.add(model.slug);
          }
          // App Server validates all model capabilities and minimum versions.
          resolve(Buffer.from(JSON.stringify({models: value.models})));
        } catch { fail(); }
      });
    });
    request.once('error', transportFail);
  });
}
