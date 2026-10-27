import {useEffect, useRef, type ReactNode} from 'react';
import {X} from 'lucide-react';
import {ModalSurface} from './ModalSurface';

type Props = {title: string; onClose: () => void; children: ReactNode; closeLabel: string; busy?: boolean; className?: string};

export default function Modal({title, onClose, children, closeLabel, busy = false, className = ''}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    element.showModal();
    element.querySelector<HTMLInputElement>('input:not([disabled])')?.focus();
    return () => {
      element.close();
      previousFocus?.focus();
    };
  }, []);
  useEffect(() => {
    if (dialog.current?.open) dialog.current.querySelector<HTMLInputElement>('input:not([disabled])')?.focus();
  }, [title]);
  return <dialog ref={dialog} className={`stone-dialog ${className}`} aria-labelledby="modal-title"
    onCancel={event => {event.preventDefault(); if (!busy) close.current();}}
    onClick={event => {if (event.target === dialog.current && !busy) close.current();}}>
    <div className="stone-dialog-frame" aria-hidden="true" />
    <div className="stone-dialog-inner" data-layout-region="dialog-scroll">
      <h2 id="modal-title" data-layout-text="dialog-title">{title}</h2>
      <ModalSurface.Provider value={true}>{children}</ModalSurface.Provider>
    </div>
    <button type="button" className="close-button" aria-label={closeLabel} title={closeLabel} onClick={onClose} disabled={busy}><X aria-hidden="true" focusable="false" strokeWidth={3} /></button>
  </dialog>;
}
