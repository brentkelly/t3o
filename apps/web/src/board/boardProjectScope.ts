/**
 * T3o: the board's project filter (`?project`, T3O-134). Any number of projects can be
 * selected; none selected means every visible project shows. The URL carries the ids
 * comma-separated and sorted, so a set has one URL (and one tab-identity key), and a
 * single-id link from before the multi-select still parses.
 */
import type { ProjectId } from "@t3tools/contracts";
import {
  mergeBoardStageColumns,
  type BoardStageColumns,
} from "@t3tools/client-runtime/state/shell";

export type BoardProjectSelection = ReadonlyArray<ProjectId>;

const EMPTY_SELECTION: BoardProjectSelection = [];
const EMPTY_COLUMNS: BoardStageColumns = mergeBoardStageColumns([]);

const normalise = (ids: Iterable<string>): BoardProjectSelection =>
  [...new Set(ids)]
    .filter((id) => id.length > 0)
    .toSorted()
    .map((id) => id as ProjectId);

export function parseBoardProjectScope(param: string | undefined): BoardProjectSelection {
  if (param === undefined || param.trim() === "") return EMPTY_SELECTION;
  return normalise(param.split(",").map((part) => part.trim()));
}

export const serializeBoardProjectScope = (selection: BoardProjectSelection): string | undefined =>
  selection.length === 0 ? undefined : normalise(selection).join(",");

export function toggleBoardProjectScope(
  selection: BoardProjectSelection,
  projectId: ProjectId,
): BoardProjectSelection {
  return selection.includes(projectId)
    ? selection.filter((id) => id !== projectId)
    : normalise([...selection, projectId]);
}

export const boardCardInProjectScope = (
  card: { readonly projectId: ProjectId },
  selection: BoardProjectSelection,
): boolean => selection.length === 0 || selection.includes(card.projectId);

/**
 * The selected projects that are on the board. Create, the pipeline columns and pill
 * dimming read this, so a selection of only hidden or deleted projects behaves as no
 * selection there, while card filtering (the raw selection) still shows the empty board.
 */
export const boardEffectiveProjectScope = (
  selection: BoardProjectSelection,
  visibleProjectIds: ReadonlyArray<ProjectId>,
): BoardProjectSelection => selection.filter((id) => visibleProjectIds.includes(id));

/** The one project a selection names, or null for none or several. */
export const boardSingleProjectScope = (selection: BoardProjectSelection): ProjectId | null =>
  selection.length === 1 ? (selection[0] ?? null) : null;

/** The root board's columns: every visible project, or the selected ones that are not hidden. */
export function boardProjectScopedColumns({
  cardsByProject,
  isHidden,
  selection,
}: {
  readonly cardsByProject: ReadonlyMap<ProjectId, BoardStageColumns>;
  readonly isHidden: (projectId: ProjectId) => boolean;
  readonly selection: BoardProjectSelection;
}): BoardStageColumns {
  const inScope = [...cardsByProject.entries()].filter(
    ([projectId]) =>
      !isHidden(projectId) && (selection.length === 0 || selection.includes(projectId)),
  );
  if (inScope.length === 0) return EMPTY_COLUMNS;
  // One project's columns pass through untouched, so their identity survives a re-render.
  if (selection.length > 0 && inScope.length === 1) return inScope[0]![1];
  return mergeBoardStageColumns(inScope.map(([, columns]) => columns));
}

/** The projects whose pipelines the root board draws: the effective selection, or every visible project. */
export function boardProjectScopePipelineProjects<P extends { readonly id: ProjectId }>(
  visibleProjects: ReadonlyArray<P>,
  effectiveSelection: BoardProjectSelection,
): ReadonlyArray<P> {
  if (effectiveSelection.length === 0) return visibleProjects;
  return visibleProjects.filter((project) => effectiveSelection.includes(project.id));
}
