// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useCallback, useEffect, useRef, useState, type PointerEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { ThreadSummary } from "./gateway-ui-events";
import type { ClientProject } from "./projects";
import { emptyLayout, readLayout, orderedThreads, sidebarGroup, moveThread, promoteThread, type SidebarLayout } from "./sidebar-order";

export function useSidebarOrganization(scope:string, threads:ThreadSummary[], projects:ClientProject[]) {
  const key=`yuanzhou-thread-layout-v1:${scope}`;
  const [snapshot,setSnapshot]=useState<{key:string;layout:SidebarLayout}>({key,layout:emptyLayout()});
  const [error,setError]=useState("");
  const current=useRef({key,threads,projects,layout:emptyLayout()});
  current.current={key,threads,projects,layout:snapshot.key===key?snapshot.layout:emptyLayout()};
  useEffect(()=>{
    const read=()=>{try{const layout=readLayout(localStorage.getItem(key));current.current.layout=layout;setSnapshot({key,layout});setError("");}catch{setError("无法读取列表偏好，请检查本机存储后重试");}};
    read();const listener=(e:StorageEvent)=>{if(e.key===key||e.key===null)read();};window.addEventListener("storage",listener);
    return()=>window.removeEventListener("storage",listener);
  },[key]);
  const write=useCallback((change:(layout:SidebarLayout,rows:ThreadSummary[])=>SidebarLayout)=>{
    const c=current.current;
    try {
      // Read the latest persisted state so another window's changes are retained.
      const base=readLayout(localStorage.getItem(c.key));
      const next=change(base,orderedThreads(c.threads,base));
      if(next===base)return;
      localStorage.setItem(c.key,JSON.stringify({version:1,...next}));
      c.layout=next;setSnapshot({key:c.key,layout:next});setError("");
    }catch {setError("列表偏好保存失败，已保留原位置。请检查本机存储后重试。");}
  },[]);
  const move=useCallback((id:string,group:string|null,anchor?:string,after=false)=>{
    if(group&&!current.current.projects.some(p=>p.id===group)){setError("目标项目已移除，请重新拖拽");return;}
    write((layout,rows)=>moveThread(layout,rows,id,group,anchor,after));
  },[write]);
  const activity=useCallback((id:string,token:string)=>{
    if(current.current.layout.seen.includes(JSON.stringify([id,token])))return;
    write((layout,rows)=>promoteThread(layout,rows,id,token));
  },[write]);
  const layout=current.current.layout;
  const group=(t:ThreadSummary)=>sidebarGroup(t,layout,new Set(projects.map(p=>p.id)));
  return {rows:orderedThreads(threads,layout),group,move,activity,error};
}

type Target={group:string|null;anchor?:string;after?:boolean};
export function useThreadDrag(scope:string,move:(id:string,group:string|null,anchor?:string,after?:boolean)=>void) {
  const [drag,setDrag]=useState<{id:string;title:string;x:number;y:number;target?:Target}>();
  const session=useRef<{id:string;title:string;pointer:number;x:number;y:number;active:boolean;target?:Target;root:HTMLElement}|undefined>(undefined);
  const suppress=useRef(false);
  const stop=useCallback(()=>{const s=session.current;if(s?.root.hasPointerCapture(s.pointer))s.root.releasePointerCapture(s.pointer);session.current=undefined;setDrag(undefined);},[]);
  useEffect(()=>{stop();},[scope,stop]);
  useEffect(()=>{const cancel=(e:KeyboardEvent)=>{if(e.key==="Escape"){if(session.current?.active)e.preventDefault();stop();}};window.addEventListener("keydown",cancel);window.addEventListener("blur",stop);return()=>{window.removeEventListener("keydown",cancel);window.removeEventListener("blur",stop);};},[stop]);
  const down=(e:PointerEvent<HTMLElement>)=>{
    suppress.current=false;
    if(e.button!==0||e.pointerType==="touch"||!(e.target instanceof Element))return;
    const button=e.target.closest<HTMLButtonElement>(".conversation-select");
    const row=button?.closest<HTMLElement>("[data-thread-id]");
    if(!row||button?.disabled)return;
    session.current={id:row.dataset.threadId!,title:button?.textContent??"对话",pointer:e.pointerId,x:e.clientX,y:e.clientY,active:false,root:e.currentTarget};
  };
  const motion=(e:PointerEvent<HTMLElement>)=>{
    const s=session.current;if(!s||s.pointer!==e.pointerId)return;
    if(!s.active&&Math.hypot(e.clientX-s.x,e.clientY-s.y)<6)return;
    s.active=true;suppress.current=true;e.preventDefault();s.root.setPointerCapture(e.pointerId);
    const hit=document.elementFromPoint(e.clientX,e.clientY);
    const group=hit?.closest<HTMLElement>("[data-thread-group]");
    const row=hit?.closest<HTMLElement>("[data-thread-id]");
    s.target=group&&s.root.contains(group)?{group:group.dataset.threadGroup||null,...(row?{anchor:row.dataset.threadId,after:e.clientY>row.getBoundingClientRect().top+row.getBoundingClientRect().height/2}:{})}:undefined;
    const box=s.root.getBoundingClientRect();
    if(e.clientY<box.top+32)s.root.scrollTop-=14;else if(e.clientY>box.bottom-32)s.root.scrollTop+=14;
    setDrag({id:s.id,title:s.title,x:e.clientX,y:e.clientY,target:s.target});
  };
  const up=(e:PointerEvent<HTMLElement>)=>{const s=session.current;if(!s||s.pointer!==e.pointerId)return;if(s.active&&s.target)move(s.id,s.target.group,s.target.anchor,s.target.after);stop();};
  const click=(e:MouseEvent)=>{if(suppress.current){e.preventDefault();e.stopPropagation();suppress.current=false;}};
  return {drag,handlers:{onPointerDown:down,onPointerMove:motion,onPointerUp:up,onPointerCancel:stop,onLostPointerCapture:stop,onClickCapture:click,onDragStart:(e:React.DragEvent)=>e.preventDefault()},
    overlay:drag?createPortal(<div className="thread-drag-preview" style={{left:Math.max(8,Math.min(drag.x+12,innerWidth-252)),top:Math.max(8,Math.min(drag.y+12,innerHeight-48))}}>{drag.title}</div>,document.body):null};
}
