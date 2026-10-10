// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Narrow contract of the pinned native extension; no URL fetching or host paths.
export const IMAGE_GENERATION_MARKER = 'yuan-zhou-image-generation/1';
export const IMAGE_BYTES_LIMIT = 20 * 1024 * 1024;
/** Older desktop parsers know only save states; keep their history/events valid. */
export function legacyImageOutput(value:unknown):unknown {
  if(record(value)&&value.source==='generatedImage'){
    if(value.status==='generating')return {...value,status:'saving'};
    if(value.status==='generationFailed')return {...value,status:'failed'};
  }
  return value;
}
type Json = Record<string, unknown>;
const record = (v:unknown):v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
/** Closed categories only: never return provider messages, prompts or request IDs. */
export function imageProviderError(value:unknown):string|undefined {
  if(!record(value))return;
  const error=record(value.error)?value.error:value;
  const code=typeof error.code==='string'?error.code.toLowerCase():'';
  if(['moderation_blocked','content_policy_violation','safety_violation'].includes(code))return 'IMAGE_CONTENT_REJECTED';
  if(['invalid_image','invalid_image_format','image_parse_error','invalid_base64_image','invalid_image_url'].includes(code))return 'IMAGE_REFERENCE_INVALID';
  if(['image_too_large','image_size_exceeded'].includes(code))return 'IMAGE_REFERENCE_TOO_LARGE';
  if(['unsupported_image_format','unsupported_image_media_type'].includes(code))return 'IMAGE_REFERENCE_UNSUPPORTED';
}
export function imageFailureMessage(code:string):string|undefined {
  const messages:Record<string,string>={
    IMAGE_CONTENT_REJECTED:'图片请求被上游内容审核拒绝，未生成图片。请核对图片与编辑要求；如认为是误判，请联系服务提供方。',
    IMAGE_REFERENCE_INVALID:'上游无法解析参考图片。请重新选择有效图片后再试。',
    IMAGE_REFERENCE_TOO_LARGE:'参考图片超过上游大小限制。请缩小图片后重新添加。',
    IMAGE_REFERENCE_UNSUPPORTED:'上游不支持该参考图片格式。请改用 PNG、JPEG 或 WebP。',
    MODEL_PROVIDER_RATE_LIMITED:'图片服务额度或请求频率受限，请稍后再试。',
    MODEL_CREDENTIAL_REJECTED:'图片服务登录凭据被拒绝，请联系中央管理员检查模型登录。',
    MODEL_PROVIDER_HTTP_400:'图片服务拒绝了请求，原因尚未识别（HTTP 400）。请联系管理员核对，勿反复重试。',
  };
  return Object.hasOwn(messages,code)?messages[code]:undefined;
}
export function imageRoute(method:string|undefined,url:string|undefined):'generations'|'edits'|undefined {
  if(method!=='POST')return;
  return /^\/(?:v1\/)?images\/(generations|edits)$/.exec(url??'')?.[1] as 'generations'|'edits'|undefined;
}
function imageBytes(value:unknown):Buffer {
  if(typeof value!=='string'||!value.length||value.length>Math.ceil(IMAGE_BYTES_LIMIT/3)*4)throw Error('IMAGE_DATA_INVALID');
  const bytes=Buffer.from(value,'base64');
  if(!bytes.length||bytes.length>IMAGE_BYTES_LIMIT||bytes.toString('base64')!==value)throw Error('IMAGE_DATA_INVALID');
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg=bytes[0]===255&&bytes[1]===216;
  const webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(!png&&!jpeg&&!webp)throw Error('IMAGE_DATA_INVALID');
  return bytes;
}
export function validateImageRequest(value:Json,route:'generations'|'edits'):void {
  const allowed=['model','prompt','background','n','quality','size',...(route==='edits'?['images']:[])];
  if(Object.keys(value).some(key=>!allowed.includes(key))||value.model!=='gpt-image-2'
    ||typeof value.prompt!=='string'||!value.prompt.trim()||value.prompt.length>32768
    ||value.n!=null&&value.n!==1
    ||value.background!=null&&!['auto','opaque','transparent'].includes(String(value.background))
    ||value.quality!=null&&!['auto','low','medium','high'].includes(String(value.quality))
    ||value.size!=null&&!['auto','1024x1024','1024x1536','1536x1024'].includes(String(value.size)))throw Error('IMAGE_REQUEST_INVALID');
  if(route==='edits'){
    if(!Array.isArray(value.images)||value.images.length<1||value.images.length>5)throw Error('IMAGE_REQUEST_INVALID');
    for(const image of value.images){
      if(!record(image)||Object.keys(image).length!==1||typeof image.image_url!=='string')throw Error('IMAGE_REQUEST_INVALID');
      const match=/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(image.image_url);
      if(!match)throw Error('IMAGE_REMOTE_REFERENCE_DENIED');
      imageBytes(match[1]);
    }
  }
}
export function sanitizeImageResponse(value:unknown):Json {
  if(!record(value)||!Number.isSafeInteger(value.created)||!Array.isArray(value.data)||value.data.length!==1||!record(value.data[0]))throw Error('IMAGE_RESPONSE_INVALID');
  imageBytes(value.data[0].b64_json);
  const result:Json={created:value.created,data:[{b64_json:value.data[0].b64_json}]};
  if(['auto','opaque','transparent'].includes(String(value.background)))result.background=value.background;
  return result;
}
