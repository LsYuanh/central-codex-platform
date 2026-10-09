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
