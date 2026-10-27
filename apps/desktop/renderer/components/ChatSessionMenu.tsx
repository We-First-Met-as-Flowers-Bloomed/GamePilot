import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Archive, MoreHorizontal, Pencil, Trash2 } from "lucide-react";

export default function ChatSessionMenu({
  title,
  pending,
  canArchive,
  canDelete,
  processing,
  onRename,
  onArchive,
  onDelete,
}: {
  title: string;
  pending: boolean;
  canArchive: boolean;
  canDelete: boolean;
  processing: boolean;
  onRename: (origin: HTMLButtonElement) => void;
  onArchive: (origin: HTMLButtonElement) => void;
  onDelete: (origin: HTMLButtonElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const height = menu.current.offsetHeight;
    setPosition({
      top: Math.min(
        rect.bottom + 4,
        Math.max(8, window.innerHeight - height - 8),
      ),
      left: Math.max(8, rect.right - 208),
    });
    menu.current
      .querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    const moved = () => close(false);
    window.addEventListener("resize", moved);
    document.addEventListener("scroll", moved, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", moved);
      document.removeEventListener("scroll", moved, true);
    };
  }, [open]);
  const run = (action: (origin: HTMLButtonElement) => void) => {
    close();
    if (trigger.current) action(trigger.current);
  };
  return (
    <div ref={container} className="chat-session-actions">
      <button
        ref={trigger}
        type="button"
        className="icon-button session-menu-trigger"
        aria-label={`会话菜单：${title}`}
        title="会话菜单"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          ref={menu}
          className="chat-session-menu"
          role="menu"
          aria-label={`整理会话：${title}`}
          style={position}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            if (event.key === "Tab") {
              close(false);
              return;
            }
            if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]:not(:disabled)',
              ),
            ];
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            items[
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index + (event.key === "ArrowUp" ? items.length - 1 : 1)) %
                    items.length
            ]?.focus();
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="session-rename"
            onClick={() => run(onRename)}
          >
            <Pencil size={14} />
            修改本机显示名称 <small>F2</small>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={pending || processing || !canArchive}
            onClick={() => run(onArchive)}
          >
            <Archive size={14} />
            归档对话
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={pending || processing || !canDelete}
            onClick={() => run(onDelete)}
          >
            <Trash2 size={14} />
            删除当前对话
          </button>
          {processing && <p className="helper">模型仍在处理，结束后可整理。</p>}
        </div>
      )}
    </div>
  );
}
