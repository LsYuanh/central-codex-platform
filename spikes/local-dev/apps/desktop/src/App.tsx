// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { getVersion } from "@tauri-apps/api/app";
import { useCallback, useEffect, useRef, useState } from "react";

type ConnectionState = "connecting" | "online" | "offline";

interface GatewayStatus {
  gateway: ConnectionState;
  agent: ConnectionState;
}

const gatewayUrl = "ws://127.0.0.1:4310/ws/ui";

export default function App() {
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const [status, setStatus] = useState<GatewayStatus>({ gateway: "connecting", agent: "offline" });
  const [runtimeVersion, setRuntimeVersion] = useState("browser preview");
  const [path, setPath] = useState("README.md");
  const [output, setOutput] = useState("等待 Local Agent 连接……");

  useEffect(() => {
    getVersion().then(setRuntimeVersion).catch(() => setRuntimeVersion("browser preview"));
  }, []);

  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setStatus((current) => ({ ...current, gateway: "connecting" }));
      const socket = new WebSocket(gatewayUrl);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        setStatus((current) => ({ ...current, gateway: "online" }));
      });

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          type?: string;
          gateway?: ConnectionState;
          agent?: ConnectionState;
          response?: unknown;
          error?: string;
        };
        if (message.type === "gateway.status") {
          setStatus({ gateway: message.gateway ?? "online", agent: message.agent ?? "offline" });
        } else if (message.type === "agent.response") {
          setOutput(JSON.stringify(message.response, null, 2));
        } else if (message.type === "gateway.error") {
          setOutput(message.error ?? "Unknown gateway error");
        }
      });

      socket.addEventListener("close", () => {
        if (disposed) return;
        setStatus({ gateway: "offline", agent: "offline" });
        reconnectTimerRef.current = window.setTimeout(connect, 1500);
      });
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
    };
  }, []);

  const sendRequest = useCallback((method: string, params: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setOutput("Fake Central 尚未连接");
      return;
    }
    const id = crypto.randomUUID();
    setOutput(`请求 ${method} (${id})……`);
    socket.send(JSON.stringify({ type: "agent.request", request: { id, method, params } }));
  }, []);

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">Phase 1 · Local vertical Spike</p>
          <h1>Central Codex Platform</h1>
          <p>桌面端不读取本机文件，只通过 Fake Central 调用最小权限 Local Agent。</p>
        </div>
        <div className="runtime">Tauri {runtimeVersion}</div>
      </header>

      <section className="status-grid" aria-label="连接状态">
        <StatusCard label="Fake Central" value={status.gateway} />
        <StatusCard label="Local Agent" value={status.agent} />
        <StatusCard label="OpenAI" value="disabled" />
      </section>

      <section className="panel">
        <h2>安全工作区验证</h2>
        <label htmlFor="path">相对路径</label>
        <input id="path" value={path} onChange={(event) => setPath(event.target.value)} />
        <div className="actions">
          <button onClick={() => sendRequest("workspace/list", { path: "." })}>列出工作区</button>
          <button onClick={() => sendRequest("read_file", { path })}>读取文件</button>
          <button onClick={() => sendRequest("exec", { program: "git", args: ["--version"], cwd: "." })}>
            运行 git --version
          </button>
        </div>
      </section>

      <section className="panel output-panel">
        <h2>AgentRPC Spike 输出</h2>
        <pre>{output}</pre>
      </section>
    </main>
  );
}

function StatusCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="status-card">
      <span>{label}</span>
      <strong className={`status-${value}`}>{value}</strong>
    </article>
  );
}
