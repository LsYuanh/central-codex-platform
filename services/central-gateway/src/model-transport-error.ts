// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
type Category = 'DNS' | 'TIMEOUT' | 'CONNECTION_RESET' | 'CONNECTION_REFUSED' | 'UNREACHABLE' | 'TLS' | 'CANCELLED' | 'MIXED' | 'UNKNOWN';
const codes: Record<string, Category> = {
  ENOTFOUND:'DNS', EAI_AGAIN:'DNS', EAI_FAIL:'DNS',
  ETIMEDOUT:'TIMEOUT', ESOCKETTIMEDOUT:'TIMEOUT', ERR_SOCKET_CONNECTION_TIMEOUT:'TIMEOUT',
  ECONNRESET:'CONNECTION_RESET', EPIPE:'CONNECTION_RESET', ECONNREFUSED:'CONNECTION_REFUSED',
  ENETUNREACH:'UNREACHABLE', EHOSTUNREACH:'UNREACHABLE', ENETDOWN:'UNREACHABLE',
  CERT_HAS_EXPIRED:'TLS', CERT_NOT_YET_VALID:'TLS', DEPTH_ZERO_SELF_SIGNED_CERT:'TLS',
  SELF_SIGNED_CERT_IN_CHAIN:'TLS', UNABLE_TO_VERIFY_LEAF_SIGNATURE:'TLS',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY:'TLS', ERR_TLS_CERT_ALTNAME_INVALID:'TLS',
  ERR_SSL_WRONG_VERSION_NUMBER:'TLS', ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE:'TLS',
  ABORT_ERR:'CANCELLED',
};

/** Read only a closed errno vocabulary, never error messages, URLs, addresses or headers.
 * Node may wrap dual-stack connection failures in AggregateError; bound traversal.
 */
export function modelTransportCategory(error: unknown): Category {
  const seen=new Set<object>();
  const visit=(value:unknown,depth:number):Category=>{
    if(!value||typeof value!=='object'||depth>3||seen.has(value))return 'UNKNOWN';
    seen.add(value);
    const e=value as {code?:unknown;name?:unknown;cause?:unknown;errors?:unknown};
    if(typeof e.code==='string'&&Object.hasOwn(codes,e.code))return codes[e.code]!;
    if(e.name==='TimeoutError')return 'TIMEOUT';
    if(e.name==='AbortError')return 'CANCELLED';
    if(Array.isArray(e.errors)&&e.errors.length){
      const categories=new Set(e.errors.slice(0,8).map(child=>visit(child,depth+1)));
      return categories.size===1?[...categories][0]!:'MIXED';
    }
    return visit(e.cause,depth+1);
  };
  return visit(error,0);
}

export class ModelTransportError extends Error {
  readonly code:string;
  constructor(stage:'REQUEST'|'STREAM'|'CATALOG',error:unknown){
    const code=`MODEL_PROVIDER_${stage}_TRANSPORT_FAILED_${modelTransportCategory(error)}`;
    super(code);this.code=code;
  }
}
