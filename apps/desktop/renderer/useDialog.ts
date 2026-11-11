import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog behavior for the model pickers: focus the first field, trap Tab,
 * close on Escape, and restore focus on unmount.
 */
export function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const node = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      node ? [...node.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
    const preferred =
      node?.querySelector<HTMLElement>('input, textarea, select') ?? focusable()[0];
    preferred?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);

  return ref;
}
