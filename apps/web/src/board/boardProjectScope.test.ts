import {
  BoardCardId,
  BOARD_SEED_STAGE_IDS,
  ProjectId,
  makeBoardCardShell,
  type BoardCardShell,
} from "@t3tools/contracts";
import type { BoardStageColumns } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardInProjectScope,
  boardEffectiveProjectScope,
  boardProjectScopedColumns,
  boardProjectScopePipelineProjects,
  boardSingleProjectScope,
  parseBoardProjectScope,
  serializeBoardProjectScope,
  toggleBoardProjectScope,
} from "./boardProjectScope";

const alpha = ProjectId.make("alpha");
const beta = ProjectId.make("beta");
const gamma = ProjectId.make("gamma");

const card = (id: string, projectId: ProjectId, orderKey = "m"): BoardCardShell =>
  makeBoardCardShell({
    cardId: BoardCardId.make(id),
    key: id.toUpperCase(),
    projectId,
    labelIds: [],
    stage: BOARD_SEED_STAGE_IDS.backlog,
    orderKey,
    title: id,
    blocked: false,
    dependencyCount: 0,
    hasBrief: false,
    archivedAt: null,
    activeThreadId: null,
  });

const columnsOf = (...cards: BoardCardShell[]): BoardStageColumns => ({
  [BOARD_SEED_STAGE_IDS.backlog]: cards,
});

const ids = (columns: BoardStageColumns) =>
  (columns[BOARD_SEED_STAGE_IDS.backlog] ?? []).map((shell) => shell.cardId as string);

describe("?project parse and serialise", () => {
  it("parses a pre-multi-select single id link as a one-project selection", () => {
    expect(parseBoardProjectScope("alpha")).toEqual([alpha]);
  });

  it("parses a list into a sorted, de-duplicated set", () => {
    expect(parseBoardProjectScope("gamma, alpha,gamma,,")).toEqual([alpha, gamma]);
  });

  it("reads absent or blank as no selection", () => {
    expect(parseBoardProjectScope(undefined)).toEqual([]);
    expect(parseBoardProjectScope("  ")).toEqual([]);
  });

  it("serialises a set to one URL whatever order it was built in", () => {
    expect(serializeBoardProjectScope([gamma, alpha])).toBe("alpha,gamma");
    expect(serializeBoardProjectScope([alpha, gamma])).toBe("alpha,gamma");
    expect(serializeBoardProjectScope([])).toBeUndefined();
  });

  it("toggles a project on in sorted position and off again", () => {
    const on = toggleBoardProjectScope([gamma], alpha);
    expect(on).toEqual([alpha, gamma]);
    expect(toggleBoardProjectScope(on, gamma)).toEqual([alpha]);
    expect(toggleBoardProjectScope([alpha], alpha)).toEqual([]);
  });
});

describe("selection semantics", () => {
  it("admits every card with nothing selected, and only selected projects' cards otherwise", () => {
    expect(boardCardInProjectScope({ projectId: beta }, [])).toBe(true);
    expect(boardCardInProjectScope({ projectId: beta }, [alpha, beta])).toBe(true);
    expect(boardCardInProjectScope({ projectId: gamma }, [alpha, beta])).toBe(false);
  });

  it("keeps only visible projects in the effective selection", () => {
    expect(boardEffectiveProjectScope([alpha, gamma], [alpha, beta])).toEqual([alpha]);
  });

  it("treats an all-stale selection as no selection for create and the pipeline", () => {
    const effective = boardEffectiveProjectScope([gamma], [alpha, beta]);
    expect(effective).toEqual([]);
    const visible = [{ id: alpha }, { id: beta }];
    expect(boardProjectScopePipelineProjects(visible, effective)).toEqual(visible);
  });

  it("names one project only when exactly one is selected", () => {
    expect(boardSingleProjectScope([alpha])).toBe(alpha);
    expect(boardSingleProjectScope([])).toBeNull();
    expect(boardSingleProjectScope([alpha, beta])).toBeNull();
  });

  it("draws the selected visible projects' pipelines, or every visible one", () => {
    const visible = [{ id: alpha }, { id: beta }, { id: gamma }];
    expect(boardProjectScopePipelineProjects(visible, [alpha, gamma])).toEqual([
      { id: alpha },
      { id: gamma },
    ]);
    expect(boardProjectScopePipelineProjects(visible, [])).toEqual(visible);
  });
});

describe("boardProjectScopedColumns", () => {
  const cardsByProject = new Map<ProjectId, BoardStageColumns>([
    [alpha, columnsOf(card("a1", alpha, "a"))],
    [beta, columnsOf(card("b1", beta, "b"))],
    [gamma, columnsOf(card("g1", gamma, "c"))],
  ]);
  const hiddenBeta = (projectId: ProjectId) => projectId === beta;

  it("merges every visible project with nothing selected", () => {
    expect(
      ids(boardProjectScopedColumns({ cardsByProject, isHidden: hiddenBeta, selection: [] })),
    ).toEqual(["a1", "g1"]);
  });

  it("merges only the selected projects, so column counts follow the filter", () => {
    expect(
      ids(
        boardProjectScopedColumns({
          cardsByProject,
          isHidden: () => false,
          selection: [alpha, beta],
        }),
      ),
    ).toEqual(["a1", "b1"]);
  });

  it("passes one selected project's columns through untouched", () => {
    expect(
      boardProjectScopedColumns({ cardsByProject, isHidden: () => false, selection: [gamma] }),
    ).toBe(cardsByProject.get(gamma));
  });

  it("shows an empty board for a selection of only hidden or unknown projects", () => {
    expect(
      ids(
        boardProjectScopedColumns({
          cardsByProject,
          isHidden: hiddenBeta,
          selection: [beta, ProjectId.make("deleted")],
        }),
      ),
    ).toEqual([]);
  });
});
