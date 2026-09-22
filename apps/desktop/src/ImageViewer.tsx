// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** A native modal traps focus, supports Escape and restores the invoking control. */
export function ImageViewer({ url, name, onClose, returnFocus }: { url: string; name: string; onClose: () => void; returnFocus?: HTMLElement | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState("");
  const deadline = useRef<number | undefined>(undefined);
  useEffect(() => {
    const previous = returnFocus ?? document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    deadline.current = window.setTimeout(() => setError("图片加载超时，请关闭后重新读取"), 15_000);
    return () => { window.clearTimeout(deadline.current); element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  // A decoded image does not need the loading deadline anymore.
  useEffect(() => { if (width) { window.clearTimeout(deadline.current); setError(""); } }, [width]);
  return createPortal(<dialog ref={dialog} className="image-viewer" aria-label={`图片预览：${name}`} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key !== "Tab") return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]'));
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="image-viewer-body">
      <div className="result-toolbar"><strong title={name}>{name}</strong><button type="button" className="result-control" disabled={!!error} onClick={() => setZoom(value => Math.max(.1, (value ?? 1) / 1.25))} aria-label="缩小图片">−</button><span>{zoom === null ? "适应窗口" : `${Math.round(zoom * 100)}%`}</span><button type="button" className="result-control" disabled={!!error} onClick={() => setZoom(value => Math.min(8, (value ?? 1) * 1.25))} aria-label="放大图片">+</button><button type="button" className="result-control" onClick={() => setZoom(null)}>适应窗口</button><button type="button" className="result-control" onClick={() => setZoom(1)}>原始尺寸</button><button type="button" className="result-control" onClick={onClose} autoFocus>关闭预览</button></div>
      <div className="image-viewer-stage" tabIndex={0} aria-label="图片区域，可滚动查看">
        {error ? <p role="alert">{error}</p> : <img src={url} alt={name} referrerPolicy="no-referrer" className={zoom === null ? "image-fit" : "image-zoom"} style={zoom !== null && width ? { width: width * zoom } : undefined} onLoad={event => { window.clearTimeout(deadline.current); setWidth(event.currentTarget.naturalWidth); }} onError={() => { window.clearTimeout(deadline.current); setWidth(0); setError("图片无法加载，请关闭后重新读取"); }} />}
      </div>
    </div>
  </dialog>, document.body);
}
