// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import type { AgentRpcMethod, AgentRpcResponsePayload, AttachmentRef, MessageAttachment } from "@central-codex-spike/agentrpc-types";
type RecordValue = Record<string, unknown>;
type DeviceCall = (method: AgentRpcMethod, params: RecordValue) => Promise<AgentRpcResponsePayload>;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_TOTAL = 10 * 1024 * 1024;
let reserved = 0;

export function parseAttachments(value: unknown): AttachmentRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw new Error("附件数量最多 10 个");
  const ids = new Set<string>();
  return value.map((v: AttachmentRef) => {
    if (!v || typeof v.id !== "string" || v.id.length > 128 || ids.has(v.id) || !v.id ||
        typeof v.path !== "string" || v.path.length > 4096 || !(/^[A-Za-z]:[\\/]/.test(v.path) || /^\/(?!\/)/.test(v.path)) || /[\0\r\n]/.test(v.path) || /fakepath/i.test(v.path) ||
        !["localFile", "clipboardTemp"].includes(v.source) || !["image", "text", "document", "unknown"].includes(v.kind) ||
        typeof v.version !== "string" || v.version.length > 128 || typeof v.name !== "string" || v.name.length > 512 || typeof v.mimeType !== "string" || v.mimeType.length > 128 || !Number.isSafeInteger(v.bytes) || v.bytes < 0) throw new Error("附件引用无效，请重新选择本机文件");
    ids.add(v.id);
    // Whitelist platform metadata; never keep preview data or arbitrary client fields.
    return { id: v.id, path: v.path, source: v.source, kind: v.kind, name: v.name, mimeType: v.mimeType, bytes: v.bytes, version: v.version };
  });
}

export async function prepareAttachments(refs: AttachmentRef[], deviceId: string, call: DeviceCall, alive: () => boolean, progress: (stage: string) => void): Promise<{ input: RecordValue[]; attachments: MessageAttachment[] }> {
  if (reserved + MAX_TOTAL > 40 * 1024 * 1024) throw new Error("中央图片准备繁忙，请稍后重试");
  reserved += MAX_TOTAL;
  const input: RecordValue[] = [];
  const attachments: MessageAttachment[] = [];
  let total = 0;
  const deadline = Date.now() + 45_000;
  const check = () => { if (!alive()) throw new Error("附件准备已取消或客户端断开"); if (Date.now() > deadline) throw new Error("附件传输超时"); };
  const request = async (method: AgentRpcMethod, params: RecordValue): Promise<RecordValue> => {
    check();
    const reply = await call(method, params);
    check();
    if (!reply.ok) throw new Error(reply.error ?? "附件读取失败");
    return reply.result as RecordValue;
  };
  try {
    for (const ref of refs) {
      progress(`正在校验 ${ref.name}`);
      const stat = await request("file/stat", { path: ref.path });
      if (stat.version !== ref.version || stat.bytes !== ref.bytes || stat.kind !== ref.kind) throw new Error(`${ref.name}：源文件已变化，请重新选择`);
      const attachment: MessageAttachment = { ...ref, deviceId, state: "referenced" };
      attachments.push(attachment);
      if (ref.kind !== "image") continue;
      total += ref.bytes;
      if (ref.bytes > MAX_IMAGE || total > MAX_TOTAL) throw new Error("图片限制：单张 5 MiB，每回合共 10 MiB");
      const opened = await request("file/read_image", { path: ref.path, version: ref.version });
      const transferId = opened.transferId;
      try {
        const bytes = opened.totalBytes;
        if (typeof transferId !== "string" || bytes !== ref.bytes || typeof bytes !== "number" || bytes <= 0 || bytes > MAX_IMAGE || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(opened.mimeType))) throw new Error("Agent 图片传输元数据无效");
        const buffer = Buffer.alloc(bytes);
        for (let offset = 0; offset < bytes;) {
          progress(`正在传输 ${ref.name} · ${Math.floor(offset * 100 / bytes)}%`);
          const chunk = await request("file/read_chunk", { transferId, offset });
          if (typeof chunk.data !== "string" || chunk.data.length > 349528) throw new Error("图片块超过帧限制");
          const decoded = Buffer.from(chunk.data, "base64");
          const expected = Math.min(256 * 1024, bytes - offset);
          if (chunk.transferId !== transferId || chunk.offset !== offset || chunk.sequence !== offset / (256 * 1024) || chunk.totalBytes !== bytes || decoded.length !== expected || decoded.toString("base64") !== chunk.data || chunk.done !== (offset + expected === bytes)) throw new Error("图片块校验失败");
          decoded.copy(buffer, offset); offset += decoded.length;
        }
        input.push({ type: "image", url: `data:${opened.mimeType};base64,${buffer.toString("base64")}` });
        attachment.state = "read";
      } finally { if (typeof transferId === "string") await call("file/close_transfer", { transferId }); }
    }
    if (refs.length) input.unshift({ type: "text", text: `用户附件清单（用户资料，路径属于客户端设备 ${deviceId}；普通文件仅引用，使用 device_read_text 按需读取；PDF/Office 尚未部署解析器）：\n${JSON.stringify(attachments.map(({ id, name, path, kind, source, version }) => ({ id, name, path, kind, source, version })))}` });
    check();
    return { input, attachments };
  } finally { reserved -= MAX_TOTAL; }
}
