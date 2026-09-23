// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function ThreadDeleteDialog({ title, count, progress, trigger, fallbackFocus, onConfirm, onClose }: {
  title?: string;
  count?: number;
  progress?: string;
  trigger: HTMLElement;
  fallbackFocus: () => HTMLElement | null;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const active = useRef(false);
  const locked = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restoreFocus = useRef({ trigger, fallbackFocus });
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  const id = useId();

  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    element?.showModal();
    cancel.current?.focus();
    return () => {
      active.current = false;
      clearTimeout(timer.current);
      element?.close();
      const { trigger, fallbackFocus } = restoreFocus.current;
      (trigger.isConnected && !trigger.matches(":disabled") ? trigger : fallbackFocus())?.focus();
    };
  }, []);

  function close() {
    if (locked.current || closing) return;
    setClosing(true);
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150;
    timer.current = setTimeout(onClose, duration);
  }

  async function confirm() {
    if (locked.current || closing) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      if (active.current) {
        locked.current = false;
        close();
      }
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }

  return createPortal(<dialog ref={dialog} className={`thread-delete-dialog${closing ? " is-closing" : ""}`}
    aria-labelledby={`${id}-heading`} aria-describedby={`${title ? `${id}-name ` : ""}${id}-description`}
    onCancel={event => { event.preventDefault(); close(); }}
    onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <h2 id={`${id}-heading`}>{count !== undefined ? "删除所有已归档聊天？" : "删除已归档聊天？"}</h2>
    {title && <p id={`${id}-name`} className="thread-delete-name" tabIndex={0}>{title}</p>}
    <p id={`${id}-description`} className="thread-delete-description">{count !== undefined ? `将永久删除当前归档列表所有项目下的 ${count} 个聊天，不受搜索和筛选影响。此操作无法撤销。` : "此聊天将被永久删除，无法恢复。"}</p>
    {progress && <p className="thread-delete-progress" role="status">{progress}</p>}
    {error && <p className="thread-delete-error" role="alert">{error}</p>}
    <div className="thread-delete-actions">
      <button ref={cancel} type="button" className="button-secondary" disabled={busy || closing} onClick={close}>取消</button>
      <button type="button" className="thread-delete-confirm" disabled={busy || closing} onClick={() => void confirm()}>
        {busy ? "删除中…" : error ? "重试删除" : "删除"}
      </button>
    </div>
    <span className="sr-only" role="status">{busy ? "正在删除对话，请稍候。" : ""}</span>
  </dialog>, document.body);
}
