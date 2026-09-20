// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "./platform-gateway-client";

export interface ClientProject { id: string; name: string; folders: string[]; revision: number }
export type ProjectDraft = Omit<ClientProject, "id" | "revision"> & { id?: string; revision?: number; creationKey?: string };
export function readProject(value: unknown): ClientProject | undefined {
  const p = value as Partial<ClientProject> | null;
  if (!p || typeof p.id !== "string" || typeof p.name !== "string" || !Array.isArray(p.folders) || !p.folders.length || !p.folders.every(f => typeof f === "string") || typeof p.revision !== "number") return;
  return { id:p.id, name:p.name, folders:[...p.folders], revision:p.revision };
}
export const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

export function useProjects(scope: string, client: RpcClient | undefined, available: boolean) {
  const [state, setState] = useState<{scope:string; rows:ClientProject[]}>({scope,rows:[]});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const current = useRef({scope,client,available}); current.current = {scope,client,available};
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!client || !available) return;
    const token = ++generation.current;
    setLoading(true);
    try {
      const response = await client.request("project/list");
      const data = response.result as {projects?:unknown[]};
      if (!Array.isArray(data?.projects) || data.projects.some(p => !readProject(p))) throw Error("项目列表响应不兼容，请重新连接");
      if (current.current.scope === scope && current.current.client === client && token === generation.current) { setState({scope,rows:data.projects.map(p => readProject(p)!)}); setError(""); }
    } catch (e) { if (token === generation.current && current.current.scope === scope) setError(String(e)); }
    finally { if (token === generation.current) setLoading(false); }
  }, [available,client,scope]);
  useEffect(() => {
    setError(""); setLoading(false);
    void refresh();
    const off = client?.subscribe(event => { if (event.method === "project/changed") void refresh(); });
    return () => { generation.current++; off?.(); };
  }, [refresh,client]);
  const request = async (method: string, params: Record<string,unknown>) => {
    if (!client || !available) throw Error("中央项目服务尚未连接，请连接后重试");
    const response = await client.request(method,params);
    if (current.current.scope !== scope || current.current.client !== client) throw Error("连接已切换，请在原连接中核对项目结果");
    return response;
  };
  const save = async (draft: ProjectDraft) => {
    const result = (await request("project/save", {...draft})).result as {project?:unknown};
    const p = readProject(result?.project);
    if (!p) throw Error("未收到有效项目，请刷新列表核对后重试");
    generation.current++; setLoading(false);
    setState(s => ({scope,rows:[...(s.scope === scope ? s.rows : []).filter(row => row.id !== p.id),p]}));
    return p;
  };
  const remove = async (p: ClientProject) => {
    await request("project/remove", {id:p.id,revision:p.revision});
    generation.current++; setLoading(false);
    setState(s => ({scope,rows:s.rows.filter(row => row.id !== p.id)}));
  };
  return { projects:state.scope === scope ? state.rows : [], loading, error, refresh, save, remove };
}
