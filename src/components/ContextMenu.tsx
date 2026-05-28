import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Draw a divider above this item. */
  separatorBefore?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** A small, keyboard-accessible right-click menu positioned at (x, y). */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Focus the first enabled item and keep the menu within the viewport.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth) left = Math.max(4, window.innerWidth - rect.width - 4);
    if (top + rect.height > window.innerHeight) top = Math.max(4, window.innerHeight - rect.height - 4);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  // Close on outside click or Escape.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  function moveFocus(from: HTMLButtonElement, dir: 1 | -1) {
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    const i = buttons.indexOf(from);
    const next = buttons[(i + dir + buttons.length) % buttons.length];
    next?.focus();
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label="Track actions"
      style={{ position: "fixed", left: x, top: y }}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={"menu-item" + (item.danger ? " is-danger" : "")}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              moveFocus(e.currentTarget, 1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              moveFocus(e.currentTarget, -1);
            }
          }}
          style={item.separatorBefore && i > 0 ? { borderTop: "1px solid var(--border)" } : undefined}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
