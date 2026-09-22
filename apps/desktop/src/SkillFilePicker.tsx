// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { UiIcon } from "./UiIcon";

export function SkillFilePicker({files,value,disabled,onChange}:{
  files:{path:string;bytes:number}[]; value:string; disabled:boolean; onChange:(file:string)=>void;
}) {
  const [open,setOpen]=useState(false),[active,setActive]=useState(0);
  const [placement,setPlacement]=useState({above:false,maxHeight:240});
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const search=useRef({text:'',time:0});
  const restoreFocus=useRef(false);
  const listId=useId();
  const selected=files.findIndex(file=>file.path===value);
  const current=files[selected];
  const activeIndex=Math.min(active,Math.max(0,files.length-1));
  const expanded=open&&!disabled&&files.length>0;
  const show=()=>{if(disabled||!files.length)return;setActive(Math.max(0,selected));search.current.text='';setOpen(true);};
  const choose=(index:number)=>{
    const file=files[index];if(disabled||!file)return;
    setOpen(false);trigger.current?.focus({preventScroll:true});
    if(file.path!==value){restoreFocus.current=true;onChange(file.path);}
  };
  useEffect(()=>{
    if(disabled)setOpen(false);
    else if(restoreFocus.current){
      restoreFocus.current=false;
      if(document.activeElement===document.body)trigger.current?.focus({preventScroll:true});
    }
  },[disabled,value]);
  useLayoutEffect(()=>{
    if(!expanded)return;
    const place=()=>{
      const box=trigger.current?.getBoundingClientRect(),dialog=root.current?.closest('dialog')?.getBoundingClientRect();
      if(!box)return;
      // Keep the popup inside the native dialog's clipping boundary.
      const below=(dialog?.bottom??innerHeight)-box.bottom-14,above=box.top-(dialog?.top??0)-14;
      const flip=below<140&&above>below;
      setPlacement({above:flip,maxHeight:Math.max(32,Math.min(240,flip?above:below))});
    };
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))setOpen(false);};
    const observer=new ResizeObserver(place);if(root.current)observer.observe(root.current);
    place();window.addEventListener('resize',place);document.addEventListener('pointerdown',outside);
    return()=>{observer.disconnect();window.removeEventListener('resize',place);document.removeEventListener('pointerdown',outside);};
  },[expanded]);
  useEffect(()=>{if(expanded)document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({block:'nearest'});},[expanded,activeIndex,listId]);
  return <div className="skill-file-select" ref={root} onBlur={event=>{
    if(!(event.relatedTarget instanceof Node)||!event.currentTarget.contains(event.relatedTarget))setOpen(false);
  }}>
    <button ref={trigger} type="button" role="combobox" aria-label="技能文件" aria-haspopup="listbox" aria-expanded={expanded}
      aria-controls={expanded?listId:undefined} aria-activedescendant={expanded?`${listId}-${activeIndex}`:undefined}
      className="skill-file-trigger" disabled={disabled||!files.length} title={current?.path}
      onClick={()=>expanded?setOpen(false):show()} onKeyDown={event=>{
        if(event.nativeEvent.isComposing)return;
        if(event.key==='Escape'&&expanded){event.preventDefault();event.stopPropagation();setOpen(false);return;}
        if(event.key==='Tab'){setOpen(false);return;}
        if(event.key==='Enter'||event.key===' '){event.preventDefault();if(expanded)choose(activeIndex);else show();return;}
        if(event.key==='ArrowDown'||event.key==='ArrowUp'){
          event.preventDefault();if(!expanded)show();else setActive((activeIndex+(event.key==='ArrowDown'?1:-1)+files.length)%files.length);return;
        }
        if(event.key==='Home'||event.key==='End'){event.preventDefault();show();setActive(event.key==='Home'?0:files.length-1);return;}
        if(event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
          event.preventDefault();const now=Date.now();const text=(now-search.current.time<700?search.current.text:'')+event.key.toLocaleLowerCase();
          if(!expanded)show();search.current={text,time:now};const index=files.findIndex(file=>file.path.toLocaleLowerCase().startsWith(text));if(index>=0)setActive(index);
        }
      }}><UiIcon name="file"/><span>{current?.path??value}</span>{current&&<small>{current.bytes} B</small>}<UiIcon name="chevronDown"/></button>
    {expanded&&<div className={`skill-file-menu${placement.above?' above':''}`} id={listId} role="listbox" aria-label="技能文件列表" style={{maxHeight:placement.maxHeight}}>
      {files.map((file,index)=><button type="button" role="option" aria-label={file.path} aria-selected={file.path===value} tabIndex={-1}
        id={`${listId}-${index}`} key={file.path} className={`skill-file-option${activeIndex===index?' highlighted':''}`} title={file.path}
        onPointerMove={()=>setActive(index)} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(index)}>
        <UiIcon name="file"/><span>{file.path}</span><small>{file.bytes} B</small><span className="skill-file-check">{file.path===value&&<UiIcon name="check"/>}</span>
      </button>)}
    </div>}
  </div>;
}
