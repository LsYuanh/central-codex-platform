// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useRef } from "react";
import { t } from "./i18n";
import { UiIcon } from "./UiIcon";
export type PermissionMode = "ask" | "auto" | "full";
export const isPermissionMode = (value: unknown): value is PermissionMode => value === "ask" || value === "auto" || value === "full";
const options = [
  { id: "ask", label: "请求批准", description: "读取直接执行，命令和文件写入先由你确认" },
  { id: "auto", label: "帮我批准", description: "由 Codex 原生审核，需要你决定时再询问" },
  { id: "full", label: "完全访问权限", description: "免除逐次审批，可操作本机账号有权访问的文件和网络" },
] as const;

export function PermissionPicker({value, disabled, supported, saving, onChange}: {
  value: PermissionMode; disabled: boolean; supported: boolean; saving: boolean; onChange: (value: PermissionMode) => Promise<void>;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  const close = () => { if(root.current) {root.current.open=false;root.current.querySelector("summary")?.focus();} };
  return <details ref={root} className="permission-picker" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open=false;
  }} onKeyDown={event => {
    if(event.key==="Escape") {event.preventDefault();close();}
    if(event.key==="ArrowDown" || event.key==="ArrowUp") {
      event.preventDefault(); event.currentTarget.open=true;
      const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index+(event.key==="ArrowDown"?1:buttons.length-1)+buttons.length)%buttons.length]?.focus();
    }
  }}>
    <summary aria-label={t("操作权限")} className={value==="full"?"permission-full":""}>
      <span>{saving?t("正在保存权限…"):supported?t(options.find(option=>option.id===value)!.label):t("操作权限")}</span><UiIcon name="chevronDown" />
    </summary>
    <div className="permission-popover" role="group" aria-label={t("操作权限")}>
      <p>{t("操作权限")}</p>
      {options.map(option=><button key={option.id} type="button" aria-pressed={option.id===value} disabled={disabled||!supported||saving}
        className={option.id==="full"?"permission-full":""} onClick={()=>{void onChange(option.id);close();}}>
        <span><strong>{t(option.label)}</strong><small>{t(option.description)}</small></span>{option.id===value&&<UiIcon name="check" />}
      </button>)}
      {!supported&&<small role="status">{t("中央运行包尚不支持权限选择，请升级后使用")}</small>}
      {supported&&disabled&&<small role="status">{t("任务结束后可以切换权限")}</small>}
    </div>
  </details>;
}
