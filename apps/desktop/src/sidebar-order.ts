// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import type { ThreadSummary } from "./gateway-ui-events";
export interface SidebarLayout { order:string[]; groups:Record<string,string|null>; seen:string[] }
export const emptyLayout = ():SidebarLayout => ({order:[],groups:{},seen:[]});
export function readLayout(raw:string|null):SidebarLayout {
  if (!raw) return emptyLayout();
  const p=JSON.parse(raw);
  if(p?.version!==1 || !Array.isArray(p.order) || !p.order.every((v:unknown)=>typeof v==="string") || !p.groups || typeof p.groups!=="object" || Array.isArray(p.groups) || !Object.values(p.groups).every(v=>v===null||typeof v==="string") || !Array.isArray(p.seen) || !p.seen.every((v:unknown)=>typeof v==="string")) throw Error("列表偏好格式不兼容");
  return {order:[...new Set<string>(p.order)],groups:p.groups,seen:p.seen};
}
export function sidebarGroup(t:ThreadSummary, layout:SidebarLayout, projects:ReadonlySet<string>):string|null {
  const id=Object.hasOwn(layout.groups,t.id)?layout.groups[t.id]:t.clientProject?.id;
  return id && projects.has(id)?id:null;
}
export function orderedThreads(threads:ThreadSummary[], layout:SidebarLayout):ThreadSummary[] {
  const rank=new Map(layout.order.map((id,i)=>[id,i]));
  return threads.filter(t=>!t.archived).sort((a,b)=>{
    const ar=rank.get(a.id),br=rank.get(b.id);
    if(ar!==undefined&&br!==undefined)return ar-br;
    if(ar!==undefined)return 1;
    if(br!==undefined)return -1;
    return (Date.parse(b.updatedAt??"")||0)-(Date.parse(a.updatedAt??"")||0)||a.id.localeCompare(b.id);
  });
}
export function moveThread(layout:SidebarLayout, rows:ThreadSummary[], id:string, group:string|null, anchor?:string, after=false):SidebarLayout {
  if(!rows.some(t=>t.id===id))throw Error("对话已不在列表中，请刷新后重试");
  if(anchor===id)return layout;
  const order=[...new Set([...rows.map(t=>t.id),...layout.order])].filter(v=>v!==id);
  const index=anchor?order.indexOf(anchor):-1;
  if(anchor&&index<0)throw Error("目标位置已变化，请重试");
  order.splice(index<0?0:index+(after?1:0),0,id);
  return {...layout,order,groups:{...layout.groups,[id]:group}};
}
export function promoteThread(layout:SidebarLayout, rows:ThreadSummary[], id:string, token:string):SidebarLayout {
  const key=JSON.stringify([id,token]);
  if(layout.seen.includes(key))return layout;
  return {...layout,order:[id,...new Set([...rows.map(t=>t.id),...layout.order].filter(v=>v!==id))],seen:[...layout.seen,key].slice(-2000)};
}
