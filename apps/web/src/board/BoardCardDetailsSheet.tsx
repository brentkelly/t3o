/**
 * T3o (T3O-134): on a phone the card's rail becomes the Details sheet, a bottom panel over the
 * full-screen card. CSS moves the rail's one DOM; this module holds the phone-only chrome
 * around it (panel button, heading, ×, scrim) and the open state. A disclosure, not a nested
 * dialog: Base UI's nested-dialog fade would wash the card out behind it.
 */
import { PanelBottomOpenIcon, XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { cn } from "../lib/utils";
import {
  BOARD_CARD_DETAILS_STATUS_LABEL,
  type BoardCardDetailsStatus,
} from "./boardCardDetailsStatus";

/** The rail's phone placement; the sheet is hidden unless open. Desktop is untouched. */
export const boardCardDetailsSheetClass = (open: boolean) =>
  cn(
    "max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-40 max-sm:max-h-[85dvh] max-sm:w-auto max-sm:overflow-y-auto max-sm:rounded-t-2xl max-sm:border-t max-sm:border-l-0 max-sm:border-border max-sm:bg-popover max-sm:pb-safe max-sm:shadow-lg",
    !open && "max-sm:hidden",
  );

export interface BoardCardDetailsSheet {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  /** The sheet's id; the panel button and scrim name it, which is how Escape finds all three. */
  readonly sheetId: string;
}

export function useBoardCardDetailsSheet(): BoardCardDetailsSheet {
  const [open, setOpen] = useState(false);
  const sheetId = useId();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a document keydown listener: Base UI closes the card on Escape at the document's bubble phase, so the open sheet takes that Escape first in the capture phase.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      const target = event.target;
      const ours =
        target === document.body ||
        (target instanceof Element &&
          (document.getElementById(sheetId)?.contains(target) === true ||
            target.closest(`[aria-controls="${CSS.escape(sheetId)}"]`) !== null ||
            target.closest(`[data-board-details-scrim="${CSS.escape(sheetId)}"]`) !== null));
      // A picker or menu opened from the sheet is portalled elsewhere: it closes first.
      if (!ours) return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, sheetId]);
  return { open, setOpen, sheetId };
}

const STATUS_DOT: Record<BoardCardDetailsStatus, string> = {
  attention: "bg-attention",
  blocked: "bg-warning",
  paused: "bg-muted-foreground",
};

const STATUS_TEXT: Record<BoardCardDetailsStatus, string> = {
  attention: "text-attention-foreground",
  blocked: "text-board-amber-text",
  paused: "text-muted-foreground",
};

/** The panel button at the end of the tab row, phones only. */
export function BoardCardDetailsButton({
  sheet,
  status,
}: {
  readonly sheet: BoardCardDetailsSheet;
  readonly status: BoardCardDetailsStatus | null;
}) {
  return (
    <button
      aria-controls={sheet.sheetId}
      aria-expanded={sheet.open}
      aria-label={
        status === null ? "Details" : `Details: ${BOARD_CARD_DETAILS_STATUS_LABEL[status]}`
      }
      className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-board-13 font-medium text-muted-foreground hover:bg-accent hover:text-foreground sm:hidden"
      onClick={() => sheet.setOpen(!sheet.open)}
      type="button"
    >
      {status === null ? null : (
        <>
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status])} />
          <span aria-hidden className={STATUS_TEXT[status]}>
            {BOARD_CARD_DETAILS_STATUS_LABEL[status]}
          </span>
        </>
      )}
      <PanelBottomOpenIcon aria-hidden className="size-4.5" />
    </button>
  );
}

/** The sheet's own heading row, phones only; the rail's sections follow it unchanged. */
export function BoardCardDetailsSheetHeader({ sheet }: { readonly sheet: BoardCardDetailsSheet }) {
  return (
    <div className="sticky top-0 z-10 flex shrink-0 flex-col bg-popover sm:hidden">
      <span aria-hidden className="mx-auto mt-2 h-1 w-9 rounded-full bg-muted-foreground/30" />
      <div className="flex items-center gap-2 py-1 pr-1.5 pl-4">
        <h3 className="flex-1 text-board-15 font-semibold">Details</h3>
        <button
          aria-label="Close details"
          className="inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => sheet.setOpen(false)}
          type="button"
        >
          <XIcon className="size-4.5" />
        </button>
      </div>
    </div>
  );
}

/** Blocks the card behind the open sheet; a tap closes it. */
export function BoardCardDetailsScrim({ sheet }: { readonly sheet: BoardCardDetailsSheet }) {
  if (!sheet.open) return null;
  return (
    <button
      aria-label="Close details"
      className="fixed inset-0 z-30 bg-black/40 sm:hidden"
      data-board-details-scrim={sheet.sheetId}
      onClick={() => sheet.setOpen(false)}
      tabIndex={-1}
      type="button"
    />
  );
}
