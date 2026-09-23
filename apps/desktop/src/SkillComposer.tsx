// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t, useLocale } from "./i18n";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { skillLabel, type Skill, type SkillService } from "./skills";
import { UiIcon } from "./UiIcon";

export interface SkillMention { id:string; revision:number; name:string; displayName?:string; start:number; end:number }
export interface ComposerDocument { text:string; mentions:SkillMention[] }

function sibling(node:Node,direction:'nextSibling'|'previousSibling') {
  let next=node[direction];while(next?.nodeType===Node.TEXT_NODE&&!next.textContent)next=next[direction];return next;
}

// The wire/plain-text representation stays $name. Only explicitly chosen chips
// carry an immutable id/revision; pasted HTML can never manufacture a chip.
function readDocument(root:Node):ComposerDocument {
  let text="";const mentions:SkillMention[]=[];
  function visit(node:Node){
    if(node instanceof HTMLElement && node.dataset.skillId){
      const name=node.dataset.skillName!,start=text.length;text+="$"+name;
      mentions.push({id:node.dataset.skillId,revision:Number(node.dataset.skillRevision),name,...(node.dataset.skillDisplayName?{displayName:node.dataset.skillDisplayName}:{}),start,end:text.length});return;
    }
    if(node.nodeType===Node.TEXT_NODE){text+=node.textContent;return;}
    // Chromium leaves a final BR as a caret placeholder, not an extra line.
    if(node.nodeName==='BR'){if(sibling(node,'nextSibling'))text+='\n';return;}
    const previous=sibling(node,'previousSibling');
    if((node.nodeName==='DIV'||node.nodeName==='P')&&previous&&previous.nodeName!=='BR')text+='\n';
    node.childNodes.forEach(visit);
  }
  root.childNodes.forEach(visit);return {text,mentions};
}
function selectionOffsets(root:HTMLElement){
  const sel=window.getSelection();if(!sel?.rangeCount)return null;
  const range=sel.getRangeAt(0);if(!root.contains(range.startContainer)||!root.contains(range.endContainer))return null;
  const prefix=document.createRange();prefix.selectNodeContents(root);prefix.setEnd(range.startContainer,range.startOffset);
  const start=readDocument(prefix.cloneContents()).text.length;
  prefix.setEnd(range.endContainer,range.endOffset);
  return {start,end:readDocument(prefix.cloneContents()).text.length};
}
function setSelection(root:HTMLElement,start:number,end=start){
  const point=(offset:number):[Node,number]=>{
    let left=offset;
    function walk(parent:Node):[Node,number]|undefined {
      for(let i=0;i<parent.childNodes.length;i++){
        const n=parent.childNodes[i];
        const previous=sibling(n,'previousSibling');
        if((n.nodeName==='DIV'||n.nodeName==='P')&&previous&&previous.nodeName!=='BR'){if(!left)return [parent,i];left--;}
        if(n instanceof HTMLElement&&n.dataset.skillId){const raw='$'+n.dataset.skillName!;if(left<raw.length)return [parent,i];left-=raw.length;if(!left)return [parent,i+1];}
        else if(n.nodeType===Node.TEXT_NODE){if(left<=n.textContent!.length)return [n,left];left-=n.textContent!.length;}
        else if(n.nodeName==='BR'){if(!left)return [parent,i];if(sibling(n,'nextSibling'))left--;}
        else {const found=walk(n);if(found)return found;}
      }
    }
    return walk(root)??[root,root.childNodes.length];
  };
  const range=document.createRange();range.setStart(...point(start));range.setEnd(...point(end));
  const sel=window.getSelection();sel?.removeAllRanges();sel?.addRange(range);
}
function chip(mention:Pick<SkillMention,'id'|'revision'|'name'|'displayName'>){
  const el=document.createElement('span');el.className='composer-skill-mention';el.contentEditable='false';
  el.dataset.skillId=mention.id;el.dataset.skillRevision=String(mention.revision);el.dataset.skillName=mention.name;
  if(mention.displayName)el.dataset.skillDisplayName=mention.displayName;
  el.textContent=skillLabel(mention);el.title=`${mention.name} · v${mention.revision}`;el.setAttribute('aria-label',t("技能 {{p0}}", { p0: mention.name }));
  return el;
}
function renderDocument(root:HTMLElement,value:ComposerDocument){
  const fragment=document.createDocumentFragment();let offset=0;
  for(const mention of value.mentions){
    if(mention.start<offset||value.text.slice(mention.start,mention.end)!=='$'+mention.name)continue;
    fragment.append(document.createTextNode(value.text.slice(offset,mention.start)),chip(mention));offset=mention.end;
  }
  fragment.append(document.createTextNode(value.text.slice(offset)));root.replaceChildren(fragment);
}

interface Props {
  value:ComposerDocument; onChange:(value:ComposerDocument)=>void; editorRef:RefObject<HTMLDivElement|null>;
  service:SkillService; disabled:boolean; skillsDisabled:boolean;
  placeholder:string; scope:string; onSend:()=>void; onPaste:(event:ClipboardEvent)=>void; manage:()=>void;
}
export function SkillComposer({value,onChange,editorRef,service,disabled,skillsDisabled,placeholder,scope,onSend,onPaste,manage}:Props){
  const locale = useLocale();
  const [trigger,setTrigger]=useState<{start:number;end:number;query:string}|null>(null);
  const [active,setActive]=useState(0),[focused,setFocused]=useState(false);
  const composing=useRef(false),savedSelection=useRef<{start:number;end:number}|null>(null),dismissed=useRef<string|null>(null);
  const listId=useId(),popupRef=useRef<HTMLDivElement>(null);
  const rows=service.rows.filter(s=>s.enabled&&(!trigger?.query||`${s.name} ${s.displayName??''} ${s.description}`.toLocaleLowerCase().includes(trigger.query.toLocaleLowerCase())));
  const selectable=service.available&&!service.loading&&!service.error&&!skillsDisabled;
  const open=!!trigger&&focused&&!disabled&&!composing.current;
  const selected=Math.min(active,Math.max(0,rows.length-1));
  function detect(){
    const root=editorRef.current;if(!root||composing.current)return;
    const selection=selectionOffsets(root);if(!selection)return;
    savedSelection.current=selection;const current=readDocument(root);
    const match=/\$([^\s$]*)$/.exec(current.text.slice(0,selection.start));
    const start=match?selection.start-match[1].length-1:-1;
    const key=`${start}:${selection.start}:${match?.[1]}`;
    if(!match||selection.start!==selection.end||current.mentions.some(m=>start>=m.start&&start<m.end)||dismissed.current===key){setTrigger(null);return;}
    setTrigger(old=>{if(old?.start===start&&old.end===selection.start&&old.query===match[1])return old;setActive(0);return {start,end:selection.start,query:match[1]};});
  }
  function sync(){const root=editorRef.current;if(root){onChange(readDocument(root));detect();}}
  function insertText(text:string){document.execCommand('insertText',false,text);sync();}
  function choose(skill:Skill){
    const root=editorRef.current;if(!root||disabled||skillsDisabled)return;
    const range=trigger??savedSelection.current??{start:value.text.length,end:value.text.length};
    root.focus({preventScroll:true});
    setSelection(root,range.start,range.end);
    // Native edit commands preserve undo/redo, unlike rebuilding the editable DOM.
    document.execCommand('insertHTML',false,chip(skill).outerHTML+' ');
    setTrigger(null);dismissed.current=null;sync();
  }
  useLayoutEffect(()=>{
    const root=editorRef.current;if(!root||composing.current)return;
    if(JSON.stringify(readDocument(root))!==JSON.stringify(value)){
      const selection=selectionOffsets(root);renderDocument(root,value);
      if(selection&&document.activeElement===root)setSelection(root,Math.min(selection.start,value.text.length),Math.min(selection.end,value.text.length));
      setTrigger(null);
    }
  },[value,editorRef]);
  useEffect(() => {
    editorRef.current?.querySelectorAll<HTMLElement>(".composer-skill-mention").forEach(chip => {
      chip.setAttribute("aria-label", t("技能 {{p0}}", { p0: chip.dataset.skillName ?? "" }));
    });
  }, [locale, editorRef]);
  useEffect(()=>{setTrigger(null);dismissed.current=null;savedSelection.current=null;},[scope]);
  useEffect(()=>{const changed=()=>{if(document.activeElement===editorRef.current)detect();};document.addEventListener('selectionchange',changed);return()=>document.removeEventListener('selectionchange',changed);});
  useEffect(()=>{if(open)popupRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});},[open,selected]);
  const host=editorRef.current?.closest('.composer-shell');
  return <><div ref={editorRef} className="composer-editor" role="textbox" aria-label={t("发送消息")} aria-multiline="true" aria-disabled={disabled}
    aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={open} aria-controls={open?listId:undefined} aria-activedescendant={open&&selectable&&rows.length?`${listId}-${selected}`:undefined}
    contentEditable={!disabled} suppressContentEditableWarning tabIndex={disabled?-1:0} data-placeholder={placeholder} data-empty={!value.text}
    onFocus={()=>{setFocused(true);detect();}} onBlur={e=>{if(!popupRef.current?.contains(e.relatedTarget as Node))setFocused(false);}}
    onInput={()=>{if(!composing.current){dismissed.current=null;sync();}}}
    onCompositionStart={()=>{composing.current=true;setTrigger(null);}} onCompositionEnd={()=>{composing.current=false;sync();}}
    onPaste={e=>{onPaste(e);if(!e.defaultPrevented){e.preventDefault();insertText(e.clipboardData.getData('text/plain'));}}}
    onCopy={e=>{const root=editorRef.current,selection=root&&selectionOffsets(root);if(root&&selection){e.preventDefault();e.clipboardData.setData('text/plain',readDocument(root).text.slice(selection.start,selection.end));}}}
    onCut={e=>{const root=editorRef.current,selection=root&&selectionOffsets(root);if(root&&selection){e.preventDefault();e.clipboardData.setData('text/plain',readDocument(root).text.slice(selection.start,selection.end));if(!disabled){document.execCommand('delete');sync();}}}}
    onDrop={e=>e.preventDefault()}
    onKeyDown={e=>{
      if(composing.current||e.nativeEvent.isComposing||e.keyCode===229)return;
      if(open){
        if(e.key==='Escape'){e.preventDefault();e.stopPropagation();dismissed.current=`${trigger!.start}:${trigger!.end}:${trigger!.query}`;setTrigger(null);return;}
        if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(rows.length)setActive((selected+(e.key==='ArrowDown'?1:-1)+rows.length)%rows.length);return;}
        if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(selectable&&rows[selected])choose(rows[selected]);return;}
      }
      if(e.key==='Enter'){e.preventDefault();if(e.shiftKey)insertText('\n');else onSend();return;}
      if((e.key==='Backspace'||e.key==='Delete')&&!e.altKey&&!e.ctrlKey&&!e.metaKey){
        const root=editorRef.current,selection=root&&selectionOffsets(root);
        if(root&&selection&&selection.start===selection.end){
          const mention=readDocument(root).mentions.find(m=>e.key==='Backspace'?m.end===selection.start:m.start===selection.start);
          if(mention){e.preventDefault();setSelection(root,mention.start,mention.end);document.execCommand('delete');sync();}
        }
      }
    }} />
    {open&&host&&createPortal(<div ref={popupRef} className="skill-suggestions" onMouseDown={e=>e.preventDefault()}>
      <div id={listId} role="listbox" aria-label={t("可用技能")} className="skill-suggestion-list">
        {selectable&&rows.map((s,i)=><div key={s.id} id={`${listId}-${i}`} role="option" aria-selected={selected===i} className="skill-suggestion" onMouseMove={()=>setActive(i)} onClick={()=>choose(s)} title={s.description}>
          <UiIcon name="skill"/><span className="skill-suggestion-name">{skillLabel(s)}</span><span className="skill-suggestion-description">{s.description}</span><small>{s.source==='builtin'?t("远舟内置"):t("个人技能")}</small>
        </div>)}
      </div>
      {skillsDisabled?<p role="status">{t("当前轮次结束后可选择技能")}</p>:!service.available?<p role="status">{t("连接支持技能的中央服务后可用")}</p>:service.loading?<p role="status">{t("正在加载技能…")}</p>:service.error?<div role="alert"><p>{t("技能加载失败")}</p><button type="button" onClick={()=>void service.refresh()}>{t("重试")}</button></div>:!rows.length?<p role="status">{service.rows.some(s=>s.enabled)?t("没有匹配的技能"):t("还没有启用的技能")}</p>:null}
      {(!rows.length||!service.available)&&<button type="button" className="skill-suggestion-manage" onClick={manage}>{t("管理我的技能")}</button>}
    </div>,host)}
  </>;
}
