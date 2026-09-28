// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useId, useRef } from "react";
import { useGoalControl } from "./GoalPanel";
import { UiIcon } from "./UiIcon";
import { t, useLocale } from "./i18n";

export type ComposerPopover = "add" | "goal" | null;
type Props = {
  control:ReturnType<typeof useGoalControl>; enabled:boolean; planMode:boolean; goalDraft:boolean; selectGoal:(active:boolean)=>void;
  planSupported:boolean; planLocked:boolean; pickFiles:()=>void; pickerDisabled:boolean;
  selectPlan:(plan:boolean)=>void; focusComposer:()=>void;
  popover:ComposerPopover; showPopover:(value:ComposerPopover)=>void;
};
export function ComposerActions(props:Props) {
  useLocale();
  const control=props.control,root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
  const id=useId(), {popover,showPopover}=props;
  const close=()=>{showPopover(null);trigger.current?.focus();};
  useEffect(()=>{
    if(popover!=="add")return;
    const outside=(event:Event)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))showPopover(null);};
    document.addEventListener("pointerdown",outside);document.addEventListener("focusin",outside);
    if(popover==="add")menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("focusin",outside);};
  },[popover,showPopover]);
  const openGoal=()=>{if(control.goal||control.error){showPopover("goal");return;}props.selectGoal(true);showPopover(null);props.focusComposer();};
  const planLocked=props.planLocked||control.loading||Boolean(control.error)||control.goal?.status==="active";
  return <div className="composer-actions" ref={root} onKeyDown={event=>{
    if(event.key==="Escape"&&popover){event.preventDefault();event.stopPropagation();close();}
  }}>
    <button ref={trigger} type="button" className="attachment-add-button" aria-label={t("添加")} title={t("添加")} aria-haspopup="menu" aria-expanded={popover==="add"} aria-controls={popover==="add"?id:undefined}
      onClick={()=>showPopover(popover==="add"?null:"add")} onKeyDown={event=>{if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();showPopover("add");}}}><UiIcon name="plus"/></button>
    {props.planSupported&&props.planMode&&<button type="button" className="composer-mode-chip plan-chip" aria-label={t("退出计划模式")} title={t("退出计划模式")} disabled={planLocked} onClick={()=>{props.selectPlan(false);showPopover(null);props.focusComposer();}}><span className="chip-icon"><UiIcon name="plan"/><span className="chip-close"><UiIcon name="close"/></span></span>{t("计划")}</button>}
    {props.enabled&&props.goalDraft&&<button type="button" className="composer-mode-chip goal-chip plan-chip" aria-label={t("退出目标模式")} title={t("退出目标模式")} disabled={props.planLocked} onClick={()=>{props.selectGoal(false);props.focusComposer();}}><span className="chip-icon"><UiIcon name="goal"/><span className="chip-close"><UiIcon name="close"/></span></span>{t("目标")}</button>}
    {popover==="add"&&<div id={id} ref={menu} className="composer-add-menu composer-popover" role="menu" aria-label={t("添加")} onKeyDown={event=>{
      if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;
      event.preventDefault();const rows=Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]);
      const index=rows.indexOf(document.activeElement as HTMLButtonElement);
      rows[event.key==="Home"?0:event.key==="End"?rows.length-1:(index+(event.key==="ArrowUp"?-1:1)+rows.length)%rows.length]?.focus();
    }}>
      <div className="composer-menu-heading">{t("添加")}</div>
      <button type="button" role="menuitem" disabled={props.pickerDisabled} onClick={()=>{close();props.pickFiles();}}><UiIcon name="paperclip"/><span>{t("添加文件")}</span><small>{t("选择本机文件")}</small></button>
      {props.enabled&&<button type="button" role="menuitem" disabled={control.busy||(!control.goal&&(control.locked||props.planMode||props.planLocked))} onClick={openGoal}><UiIcon name="goal"/><span>{t("目标")}</span><small>{t("设置要持续追求的目标")}</small></button>}
      {props.planSupported&&<button type="button" role="menuitemcheckbox" aria-checked={props.planMode} disabled={planLocked} onClick={()=>{props.selectPlan(!props.planMode);showPopover(null);props.focusComposer();}}><UiIcon name="plan"/><span>{t("计划模式")}</span><small>{t(props.planMode?"退出计划模式":"开启计划模式")}</small>{props.planMode&&<UiIcon name="check"/>}</button>}
    </div>}
  </div>;
}
