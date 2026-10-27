import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import {
  commandMatches,
  isComposingKey,
  nextCommandIndex,
} from "../slash-command-state";
import "../commands.css";

export interface PaletteCommand {
  id: string;
  label: string;
  keywords?: string;
  detail?: string;
  disabled?: boolean;
  run: () => void;
}

export function paletteFocusTarget(
  origin: HTMLElement | null,
  candidates: HTMLElement[],
) {
  const visible = (element: HTMLElement | null): element is HTMLElement =>
    Boolean(
      element?.isConnected &&
      !element.closest("[hidden], [inert]") &&
      element.getClientRects().length,
    );
  return visible(origin) ? origin : candidates.find(visible);
}

export default function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const matches = commands.filter((command) =>
    commandMatches(`${command.label} ${command.keywords ?? ""}`, query),
  );
  const activeIndex = Math.min(selected, Math.max(0, matches.length - 1));
  const active = matches[activeIndex];
  useEffect(() => {
    if (open) {
      origin.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setSelected(0);
      dialog.current?.showModal();
      search.current?.focus();
    } else if (dialog.current?.open) {
      dialog.current.close();
      const target = paletteFocusTarget(origin.current, [
        ...document.querySelectorAll<HTMLElement>(
          "main .page h1, main .page h2",
        ),
        ...document.querySelectorAll<HTMLElement>(
          "main .page button:not([disabled]), main .page input:not([disabled])",
        ),
        ...document.querySelectorAll<HTMLElement>(
          ".topbar button:not([disabled])",
        ),
      ]);
      if (target?.matches("h1, h2")) target.tabIndex = -1;
      target?.focus({ preventScroll: true });
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const list = dialog.current?.querySelector<HTMLElement>(
      ".command-palette-list",
    );
    const option = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !option) return;
    const viewport = list.getBoundingClientRect(),
      selected = option.getBoundingClientRect();
    if (selected.top < viewport.top)
      list.scrollTop += selected.top - viewport.top;
    else if (selected.bottom > viewport.bottom)
      list.scrollTop += selected.bottom - viewport.bottom;
  }, [open, active?.id]);
  const choose = (command?: PaletteCommand) => {
    if (!command || command.disabled) return;
    onClose();
    command.run();
  };
  return (
    <dialog
      ref={dialog}
      id="command-palette-dialog"
      className="command-palette"
      aria-modal="true"
      aria-labelledby="command-palette-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (isComposingKey(event.nativeEvent)) {
          if (event.key === "Escape") event.preventDefault();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
        if (event.key === "Tab") {
          const elements = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'input, button:not([disabled]):not([tabindex="-1"])',
            ),
          ];
          const first = elements[0],
            last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div className="command-palette-heading">
        <h2 id="command-palette-title">命令面板</h2>
        <button
          className="icon-button"
          type="button"
          aria-label="关闭命令面板"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <div className="command-palette-search">
        <Search size={18} aria-hidden="true" />
        <input
          ref={search}
          id="command-palette-query"
          value={query}
          aria-label="搜索命令"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls="command-palette-list"
          aria-activedescendant={active ? `palette-${active.id}` : undefined}
          placeholder="搜索页面、会话与外观…"
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (isComposingKey(event.nativeEvent)) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setSelected(
                nextCommandIndex(activeIndex, matches.length, event.key),
              );
            }
            if (event.key === "Enter") {
              event.preventDefault();
              choose(active);
            }
          }}
        />
      </div>
      <div
        id="command-palette-list"
        role="listbox"
        aria-label="界面命令"
        className="command-palette-list"
      >
        {matches.map((command, index) => (
          <button
            key={command.id}
            id={`palette-${command.id}`}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={index === activeIndex}
            aria-disabled={command.disabled || undefined}
            disabled={command.disabled}
            data-command-id={command.id}
            onClick={() => choose(command)}
            onMouseEnter={() => setSelected(index)}
          >
            <span>{command.label}</span>
            {command.detail && <small>{command.detail}</small>}
          </button>
        ))}
      </div>
      {!matches.length && (
        <p className="command-palette-empty" role="status">
          没有匹配的界面命令。
        </p>
      )}
      <p className="command-palette-help">
        仅切换界面与本机外观 · ↑↓ 选择 · Enter 确认 · Esc 关闭
      </p>
    </dialog>
  );
}
