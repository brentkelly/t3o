/**
 * T3o: the project filter the root board and the List view share (`?project`, T3O-134).
 * One pill per visible project; any number can be on, none means every project shows.
 * A selected id that is no longer on the board (deleted, hidden, another environment's)
 * keeps a dimmed pill so the user can take it off again.
 */
import type { ProjectIconColor, ProjectId } from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { projectAccent } from "./projectAccent";
import {
  boardEffectiveProjectScope,
  toggleBoardProjectScope,
  type BoardProjectSelection,
} from "./boardProjectScope";

const PILL_CLASS =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-board-12 font-medium transition-colors max-sm:h-10 max-sm:px-3 max-sm:text-board-13";

export function BoardProjectFilter({
  projects,
  selection,
  projectsLoaded,
  isHidden,
  accentNameFor,
  onChange,
}: {
  /** The visible (not hidden) projects, in board order. */
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly selection: BoardProjectSelection;
  /** False until the project list arrives, so a fresh load shows no stale pills. */
  readonly projectsLoaded: boolean;
  readonly isHidden: (projectId: ProjectId) => boolean;
  readonly accentNameFor: (projectId: ProjectId) => ProjectIconColor | null;
  readonly onChange: (selection: BoardProjectSelection) => void;
}) {
  const visibleIds = projects.map((project) => project.id);
  const staleIds = projectsLoaded ? selection.filter((id) => !visibleIds.includes(id)) : [];
  if (projects.length <= 1 && staleIds.length === 0) return null;
  const dimUnselected = boardEffectiveProjectScope(selection, visibleIds).length > 0;
  return (
    <div className="flex min-w-0 items-center gap-1.5 max-sm:flex-1 max-sm:basis-full">
      <div
        aria-label="Filter by project"
        className="flex min-w-0 items-center gap-1.5 sm:flex-wrap max-sm:flex-1 max-sm:overflow-x-auto max-sm:[scrollbar-width:none]"
        role="group"
      >
        {projects.map((project) => {
          const selected = selection.includes(project.id);
          const accent = projectAccent(project.id, accentNameFor(project.id));
          return (
            <button
              aria-pressed={selected}
              className={cn(
                PILL_CLASS,
                selected
                  ? "font-semibold text-foreground"
                  : dimUnselected
                    ? "border-border/70 bg-transparent text-muted-foreground hover:text-foreground"
                    : "border-border bg-card text-foreground hover:bg-accent",
              )}
              key={project.id}
              onClick={() => onChange(toggleBoardProjectScope(selection, project.id))}
              style={
                selected
                  ? {
                      backgroundColor: `color-mix(in srgb, ${accent.mutedHex} 16%, transparent)`,
                      borderColor: accent.mutedHex,
                    }
                  : undefined
              }
              type="button"
            >
              <span
                aria-hidden
                className={cn("h-[3px] w-[11px] shrink-0 rounded-xs", accent.dot)}
              />
              {project.title}
            </button>
          );
        })}
        {staleIds.map((id) => (
          <button
            aria-pressed
            className={cn(PILL_CLASS, "border-dashed border-border text-muted-foreground")}
            key={id}
            onClick={() => onChange(toggleBoardProjectScope(selection, id))}
            aria-label={`Remove ${isHidden(id) ? "hidden" : "unknown"} project from the filter`}
            type="button"
          >
            {isHidden(id) ? "Hidden project" : "Unknown project"}
            <XIcon aria-hidden className="size-3" />
          </button>
        ))}
      </div>
      {selection.length === 0 ? null : (
        <button
          aria-label="Clear project filter"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-board-12 text-muted-foreground hover:bg-accent hover:text-foreground max-sm:h-10 max-sm:bg-muted max-sm:text-foreground"
          onClick={() => onChange([])}
          type="button"
        >
          <XIcon aria-hidden className="size-3.5" />
          <span className="max-sm:hidden">Clear</span>
          <span className="sm:hidden">{selection.length}</span>
        </button>
      )}
    </div>
  );
}
