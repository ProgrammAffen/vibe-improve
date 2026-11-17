import {useEffect, useId, useRef, type ReactNode} from 'react';
import {X} from 'lucide-react';
import {ModalSurface} from './ModalSurface';

type Props = {title: string; onClose: () => void; children: ReactNode; closeLabel: string; busy?: boolean; className?: string; focusHeading?: boolean; explicitClose?: boolean};

export default function Modal({title, onClose, children, closeLabel, busy = false, className = '', focusHeading = false, explicitClose = false}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const canDismiss = !busy && !explicitClose;
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    element.showModal();
    if (focusHeading) element.querySelector<HTMLElement>('h2')?.focus({preventScroll: true});
    else element.querySelector<HTMLInputElement>('input:not([disabled])')?.focus();
    return () => {
      element.close();
      previousFocus?.focus();
    };
  }, []);
  useEffect(() => {
    if (!focusHeading && dialog.current?.open) dialog.current.querySelector<HTMLInputElement>('input:not([disabled])')?.focus();
  }, [title, focusHeading]);
  return <dialog ref={dialog} className={`stone-dialog ${className}`} aria-labelledby={titleId}
    onCancel={event => {event.preventDefault(); if (canDismiss) close.current();}}
    onClick={event => {if (event.target === dialog.current && canDismiss) close.current();}}>
    <div className="stone-dialog-frame" aria-hidden="true" />
    <div className="stone-dialog-inner" data-layout-region="dialog-scroll">
      <h2 id={titleId} data-layout-text="dialog-title" tabIndex={focusHeading ? -1 : undefined} autoFocus={focusHeading}>{title}</h2>
      <ModalSurface.Provider value={true}>{children}</ModalSurface.Provider>
    </div>
    <button type="button" className="close-button" aria-label={closeLabel} title={closeLabel} onClick={onClose} disabled={busy}><X aria-hidden="true" focusable="false" strokeWidth={3} /></button>
  </dialog>;
}
