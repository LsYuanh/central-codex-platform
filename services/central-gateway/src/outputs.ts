// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { createHash } from "node:crypto";
import type { AgentRpcMethod, AgentRpcResponsePayload, OutputArtifact } from "@central-codex-spike/agentrpc-types";
type Json = Record<string, unknown>;
const LIMIT = 20 * 1024 * 1024;
const CHUNK = 256 * 1024;
export const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Image bytes come from App Server events; this class never reads a host path. */
export class OutputBroker {
  private pending = new Map<string, Promise<void>>();
  private active = 0;
  constructor(private readonly options: {
    summary(threadId: string): Json | undefined;
    call(deviceId: string, method: AgentRpcMethod, params: Json): Promise<AgentRpcResponsePayload>;
    deviceKey(deviceId: string): string | undefined;
    changed(threadId: string, output: OutputArtifact): void;
  }) {}

  list(threadId: string): OutputArtifact[] {
    const summary = this.options.summary(threadId);
    if (!summary) return [];
    if (!Array.isArray(summary.outputs)) summary.outputs = [];
    return summary.outputs as OutputArtifact[];
  }
  async settled(threadId: string) {
    await Promise.all([...this.pending].filter(([key]) => key.startsWith(`${threadId}/`)).map(([, task]) => task));
    return this.list(threadId);
  }
  finishGeneration(threadId:string,turnId?:string){
    // A completed turn may finish saving after the next turn has already started.
    for(const output of this.list(threadId))if(output.status==='generating'&&(!turnId||output.turnId===turnId)){
      output.status='generationFailed';output.error='图片生成已结束或中断，未收到完整图片；请查看对话错误后重试生成';this.changed(output);
    }
  }
  private changed(output: OutputArtifact) { this.options.changed(output.threadId, output); }
  private async request(output: OutputArtifact, method: AgentRpcMethod, params: Json): Promise<Json> {
    if (!output.deviceKey || this.options.deviceKey(output.deviceId) !== output.deviceKey) throw new Error("来源设备离线或身份不一致，请连接原设备后重试");
    const result = await this.options.call(output.deviceId, method, params);
    if (!result.ok || !isRecord(result.result)) throw new Error(result.error ?? "客户端文件操作失败");
    return result.result;
  }
  private applyFile(output: OutputArtifact, file: Json) {
    if (file.verified !== true || typeof file.path !== "string" || typeof file.version !== "string" || typeof file.sha256 !== "string" || typeof file.name !== "string" || !Number.isSafeInteger(file.bytes)) throw new Error("Local Agent 未返回可核实的文件结果");
    Object.assign(output, { path:file.path, name:file.name, kind:file.kind, mimeType:file.mimeType, bytes:file.bytes, version:file.version, sha256:file.sha256, status:"saved" });
    delete output.error;
    this.changed(output);
  }
  recordFile(threadId: string, turnId: string | undefined, id: string, deviceId: string, file: Json): OutputArtifact {
    let output = this.list(threadId).find(v => v.id === id);
    if (!output) {
      output={id,threadId,turnId,deviceId,deviceKey:this.options.deviceKey(deviceId),source:"deviceFile",name:String(file.name??"输出文件"),kind:"unknown",status:"saving"};
      this.list(threadId).push(output);
    }
    this.applyFile(output,file); return output;
  }
  async collect(threadId: string, result: unknown): Promise<void> {
    if (!isRecord(result)) return;
    const thread = isRecord(result.thread) ? result.thread : result;
    if (!Array.isArray(thread.turns)) return;
    for (const turn of thread.turns) {
      if (!isRecord(turn) || !Array.isArray(turn.items)) continue;
      for (const item of turn.items) {
        if (isRecord(item) && item.type === "imageGeneration") await this.image(threadId, typeof turn.id === "string" ? turn.id : undefined, item);
        // Backfill client file outputs if the gateway restarted after a tool result.
        if (isRecord(item) && item.type === "dynamicToolCall" && Array.isArray(item.contentItems) && typeof item.id === "string") {
          if (this.list(threadId).some(o => o.id === item.id)) continue;
          const summary=this.options.summary(threadId);
          for (const part of item.contentItems) {
            if (!isRecord(part) || typeof part.text !== "string") continue;
            try {
              const reply=JSON.parse(part.text);
              if (reply.output?.source === "deviceFile" && reply.output?.deviceId === summary?.deviceId && reply.result?.verified === true) this.recordFile(threadId,String(turn.id),item.id,String(summary?.deviceId),reply.result);
            } catch { /* Ordinary dynamic-tool text is not an output record. */ }
          }
        }
      }
    }
  }
  async retry(threadId: string, id: string, history: unknown): Promise<OutputArtifact> {
    const output=this.list(threadId).find(v=>v.id===id);
    if (!output || output.source!=="generatedImage") throw new Error("该输出不支持重新保存，请重新执行原文件操作");
    if (output.status === "saved") return output;
    const thread=isRecord(history)&&isRecord(history.thread)?history.thread:history;
    const turns=isRecord(thread)&&Array.isArray(thread.turns)?thread.turns:[];
    for(const turn of turns) if(isRecord(turn)&&Array.isArray(turn.items)) {
      const item=turn.items.find(v=>isRecord(v)&&v.type==="imageGeneration"&&v.id===id);
      if(isRecord(item)){await this.image(threadId,output.turnId,item,true);return output;}
    }
    throw new Error("中央历史中没有可恢复的图片内容");
  }
  image(threadId: string, turnId: string | undefined, item: Json, retry=false): Promise<void> {
    if (typeof item.id!=="string") return Promise.resolve();
    const key=`${threadId}/${item.id}`;
    const pending=this.pending.get(key); if(pending)return pending;
    const entries=this.list(threadId);
    let output=entries.find(v=>v.id===item.id);
    if(output && output.status!=='generating' && output.status!=='generationFailed' && (!retry || output.status==="saved"))return Promise.resolve();
    if (!output) {
      if (!["in_progress","completed","failed"].includes(String(item.status))) return Promise.resolve();
      const summary=this.options.summary(threadId);if(!summary||typeof summary.deviceId!=="string")return Promise.resolve();
      const safeId=createHash("sha256").update(`${threadId}/${item.id}`).digest("hex").slice(0,16);
      output={id:item.id,threadId,turnId,deviceId:summary.deviceId,deviceKey:typeof summary.deviceKey==="string"?summary.deviceKey:this.options.deviceKey(summary.deviceId),source:"generatedImage",name:`generated-${safeId}.png`,kind:"image",status:"saving"};
      entries.push(output);
    }
    if(item.status==='in_progress'){
      // A stale history event must not turn a failed/interrupted output into a spinner.
      if(output.status==='generationFailed')return Promise.resolve();
      output.status='generating';this.changed(output);return Promise.resolve();
    }
    if(item.failure||item.status!=='completed'){
      output.status='generationFailed';output.error='图片生成失败，未收到可保存的完整图片；请查看对话错误后重试生成';this.changed(output);return Promise.resolve();
    }
    output.status="saving";delete output.error;this.changed(output);
    const target=output;
    const task=this.saveImage(target,item).catch(error=>{target.status="failed";target.error=error instanceof Error?error.message:String(error);this.changed(target);}).finally(()=>this.pending.delete(key));
    this.pending.set(key,task);return task;
  }
  private async saveImage(output: OutputArtifact,item:Json):Promise<void>{
    if (item.failure || item.status!=="completed") throw new Error("中央图片生成失败，没有可保存的完整图片");
    if (typeof item.result!=="string" || !item.result) throw new Error("中央未返回图片数据；不会将中央文件路径当作本机路径");
    const encoded=item.result.replace(/^data:image\/(?:png|jpeg|webp|gif);base64,/,"");
    if(encoded.length>Math.ceil(LIMIT/3)*4)throw new Error("生成图片超过 20 MiB 保存上限");
    if(this.active>=4)throw new Error("客户端输出保存繁忙，请重试");
    this.active++;
    let transferId: string | undefined;
    const deadline=Date.now()+45_000;
    const writeRequest=(method:AgentRpcMethod,params:Json)=>{
      if(Date.now()>deadline)throw new Error("客户端图片保存超时，请重试并核对本机文件");
      return this.request(output,method,params);
    };
    try {
      const bytes=Buffer.from(encoded,"base64");
      if(!bytes.length || bytes.length>LIMIT || bytes.toString("base64")!==encoded)throw new Error("中央图片 Base64 校验失败");
      const extension=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?"png":bytes[0]===255&&bytes[1]===216?"jpg":bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WEBP"?"webp":bytes.toString("ascii",0,3)==="GIF"?"gif":undefined;
      if(!extension)throw new Error("中央图片格式无法识别");
      output.name=output.name.replace(/\.[^.]+$/,`.${extension}`);
      const digest=createHash("sha256").update(bytes).digest("hex");
      const opened=await writeRequest("file/write_begin",{name:output.name,totalBytes:bytes.length,sha256:digest,image:true});
      if(typeof opened.transferId!=="string")throw new Error("客户端未返回写入会话");
      transferId=opened.transferId;
      for(let offset=0;offset<bytes.length;offset+=CHUNK){
        const chunk=bytes.subarray(offset,offset+CHUNK);
        const result=await writeRequest("file/write_chunk",{transferId,offset,data:chunk.toString("base64")});
        if(result.nextOffset!==offset+chunk.length)throw new Error("客户端写入进度不一致");
      }
      const file=await writeRequest("file/write_commit",{transferId});
      if(file.sha256!==digest || file.bytes!==bytes.length)throw new Error("客户端保存结果校验失败");
      this.applyFile(output,file);
    }finally{
      if(transferId)await this.request(output,"file/write_abort",{transferId}).catch(()=>undefined);
      this.active--;
    }
  }
}
