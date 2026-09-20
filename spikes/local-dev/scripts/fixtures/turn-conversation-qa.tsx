// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TurnConversation } from "../../apps/desktop/src/TurnConversation";
import { MarkdownMessage } from "../../apps/desktop/src/MarkdownMessage";
import { ThemePicker } from "../../apps/desktop/src/ThemePicker";
import { ThreadActions } from "../../apps/desktop/src/ThreadActions";
import type { ThemeMode } from "../../apps/desktop/src/theme";
import type { ChatMessage } from "../../apps/desktop/src/gateway-ui-events";
import type { TurnTimingStatus } from "../../apps/desktop/src/turn-timing";
import "../../apps/desktop/src/styles.css";

function Fixture() {
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [action, setAction] = useState("");
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const [status, setStatus] = useState<TurnTimingStatus>("running");
  const [tick, setTick] = useState(38000);
  const [id, setId] = useState("t1");
  const [stepCount, setStepCount] = useState(0);
  const [stepComplete, setStepComplete] = useState(false);
  const rows: ChatMessage[] = [
    { id: "u", role: "user", content: "整理一份实施方案" },
    { id: "r", role: "assistant", kind: "reasoning", content: "检查现有消息类型，确认需要保留的事件。" },
    { id: "c", role: "assistant", phase: "commentary", content: "我会先梳理事件，再完善展示。" },
    { id: "tool", role: "assistant", kind: "tool", itemStatus: "running", content: "搜索网页" },
    { id: "dup", role: "assistant", kind: "tool", toolName: "device_exec", content: "请求客户端工具 · device_exec", itemStatus: status === "running" ? "running" : status === "failed" ? "failed" : "completed" },
    { id: "e", role: "assistant", kind: "execution", content: "", executionId: "e" },
    ...Array.from({ length: stepCount }, (_, index): ChatMessage => ({ id: `live-${index}`, role: "assistant", kind: "tool",
      itemStatus: index < stepCount - 1 || stepComplete ? "completed" : "running", content: `最新步骤 ${index + 1}` })),
    { id: "s", role: "user", content: "文件也要保留可见" },
    { id: "f", role: "assistant", phase: "final_answer", content: "最终结果：消息分类和历史恢复已完成。" },
    { id: "file", role: "assistant", content: "", outputs: [{ id: "file", name: "实施方案.doc" } as never] },
    { id: "legacy", role: "assistant", content: "旧版普通回复仍可见" },
  ];
  const execution = { requestId: "e", tool:"device_exec", phase:"executing", status: status === "running" ? "running" : status === "failed" ? "failed" : "succeeded" } as const;
  return <>
    <nav aria-label="外观与菜单测试"><ThemePicker value={theme} onChange={setTheme} /><ThreadActions title="测试对话" disabled={false} rename={() => setAction("rename")} archive={() => setAction("archive")} /><output data-testid="menu-action">{action}</output></nav>
    <nav aria-label="测试控制"><button onClick={() => setStatus("completed")}>完成测试</button><button onClick={() => setTick(tick + 1000)}>更新时钟</button>
      <button onClick={() => { setId("t2"); setStatus("running"); setStepCount(0); }}>下一轮测试</button><button onClick={() => setStatus("unknown")}>断线测试</button><button onClick={() => setStatus("failed")}>失败测试</button>
      <button onClick={() => { setStepCount(stepCount + 1); setStepComplete(false); }}>追加步骤</button><button onClick={() => setStepComplete(true)}>步骤完成</button></nav>
    <main className="message-list" style={{ height: "calc(100vh - 48px)" }}>
      <TurnConversation key={id} group={{ id, turnId: id, messages: rows.map(row => ({ ...row, turnId: id })) }}
        timing={{ threadId: "qa", turnId: id, status, startedAt: 1000, durationMs: status === "running" ? undefined : 38000, updatedAt: 1000 }} running={status === "running"} now={1000 + tick}
        executions={[execution as never]} renderExecution={() => <div data-testid="execution">本机执行记录 · 测试命令</div>}
        renderMessage={row => row.kind === "tool" ? <div className="process-tool-summary" key={row.id} data-testid={row.id} data-status={row.itemStatus}>
          <svg width="16" height="16" aria-hidden="true" /><span>{row.content}</span><span>{row.itemStatus === "running" ? "处理中" : "已结束"}</span>
        </div> : <article className={`chat-message-row chat-message-row-${row.role}`} key={row.id} data-testid={row.id} data-status={row.itemStatus}>
          <div className={`chat-bubble bubble-${row.role}`}><MarkdownMessage content={row.content} />{row.outputs?.map(output => <div className="output-card" key={output.id}>{output.name}</div>)}</div>
        </article>} />
    </main>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
