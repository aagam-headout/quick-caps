import { useEffect, useRef, useState } from 'react';

/**
 * Open/close state for a floating dropdown panel: closes on an outside
 * pointer down or Escape. Shared by MultiSelectDropdown and
 * SingleSelectDropdown so the listener wiring exists once.
 */
export function useDropdown<T extends HTMLElement>() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<T>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return { open, setOpen, rootRef };
}
