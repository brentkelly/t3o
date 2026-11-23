/**
 * The List view's surface: the board's top bar with the List tab
 * active, the same `?project` scope as the root board, the outline, and the
 * card popup over it (`?card`). Board-owned and full-bleed, like the board.
 */
import {
  BoardCardId,
  BOARD_SEED_STAGES,
  assignBoardKeyPrefix,
  boardCardAttention,
  isBoardProjectHidden,
  type BoardCardShell,
  type BoardStageDefinition,
  type BoardState,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useSearch } from "@tanstack/react-router";

import { SidebarInset } from "../components/ui/sidebar";
import { environmentProjects } from "../state/projects";
import { boardEnvironment } from "../state/board";
import { validateBoardSearch, type BoardSearch } from "../routes/board";
import { useBoardAttentionSettle } from "./boardAttentionSettle";
import { BoardCardDetail } from "./BoardCardDetail";
import { BoardListView } from "./BoardListView";
import { BoardProjectFilter } from "./BoardProjectFilter";
import {
  boardCardInProjectScope,
  boardEffectiveProjectScope,
  boardProjectScopePipelineProjects,
  parseBoardProjectScope,
  serializeBoardProjectScope,
} from "./boardProjectScope";
import { BoardServerUnavailableNotice } from "./BoardServerSettings";
import { BoardCardFilterField, BoardTopBar } from "./BoardTopBar";
import { useBoardUiStore } from "./boardUiStore";
import { BoardUtilityMenu } from "./BoardUtilityMenu";
import { projectIconColorOf } from "./projectAccent";
import { useBoardEnvironment, useBoardSettings } from "./useBoardEnvironmentId";

/** The List view's own filter text, apart from every board's. */
const LIST_QUERY_KEY = "list";

function stageStateOf(stages: ReadonlyArray<BoardStageDefinition>): BoardState {
  return { cards: [], stages, nextCardNumberByProject: {} };
}

function BoardListPage() {
  const board = useBoardEnvironment();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <BoardUtilityMenu />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {board.kind === "ready" ? (
          <EnvironmentList environmentId={board.environmentId} />
        ) : (
          <>
            <BoardTopBar mode="list" />
            <div className="flex flex-1 items-center justify-center p-6">
              {board.kind === "unavailable" ? (
                <div className="w-full max-w-md">
                  <BoardServerUnavailableNotice label={board.label} />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No connected environment.</p>
              )}
            </div>
          </>
        )}
      </div>
    </SidebarInset>
  );
}

function EnvironmentList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const search = useSearch({ strict: false }) as BoardSearch;
  const navigate = useNavigate();
  const allProjects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const threadShellsById = useAtomValue(boardEnvironment.cardThreadShellsAtom(environmentId));
  const cardsByProject = useAtomValue(boardEnvironment.cardsByProjectAtom(environmentId));
  const stageList = useAtomValue(boardEnvironment.stageListAtom(environmentId));
  const orderedStages = stageList.length > 0 ? stageList : BOARD_SEED_STAGES;
  const stageState = stageStateOf(orderedStages);
  const boardSettings = useBoardSettings((settings) => settings.board);

  const accentByProject = new Map(
    allProjects.map((project) => [project.id, projectIconColorOf(project)] as const),
  );
  const accentNameFor = (projectId: ProjectId) => accentByProject.get(projectId) ?? null;
  const projects = allProjects.filter(
    (project) => !isBoardProjectHidden(boardSettings, project.id),
  );
  const projectSelection = parseBoardProjectScope(search.project);
  const effectiveProjectSelection = boardEffectiveProjectScope(
    projectSelection,
    projects.map((project) => project.id),
  );

  // Every live card of every visible project: a group's rules read across
  // projects, and a child in another project still shows under its group.
  const allShells = [...cardsByProject.values()].flatMap((columns) =>
    Object.values(columns).flat(),
  );
  const shells = allShells.filter((card) => !isBoardProjectHidden(boardSettings, card.projectId));
  const inScope = (card: BoardCardShell) => boardCardInProjectScope(card, projectSelection);

  // "Needs you" agrees with the board's card faces: same settle grace.
  const threadShellOf = (threadId: ThreadId) => threadShellsById.get(threadId);
  const { threadIdleSinceByCard, now } = useBoardAttentionSettle({
    cards: shells,
    threadOf: threadShellOf,
  });
  const attentionFor = (card: BoardCardShell) => {
    const threadIdleSince = threadIdleSinceByCard.get(String(card.cardId));
    return boardCardAttention({
      card: threadIdleSince === undefined ? card : { ...card, threadIdleSince },
      stages: orderedStages,
      now,
    });
  };

  const keyPrefixFor = (projectId: ProjectId) =>
    assignBoardKeyPrefix({
      board: boardSettings,
      projectId,
      projectTitle: allProjects.find((project) => project.id === projectId)?.title ?? "",
    }).prefix;

  const query = useBoardUiStore((state) => state.queryByBoard[LIST_QUERY_KEY] ?? "");
  const setBoardQuery = useBoardUiStore((state) => state.setBoardQuery);
  const setQuery = (next: string) => setBoardQuery(LIST_QUERY_KEY, next);

  const patchSearch = (
    updater: (previous: BoardSearch) => BoardSearch,
    options?: { readonly replace?: boolean },
  ) => {
    void navigate({
      to: ".",
      search: (previous) => updater(validateBoardSearch(previous)),
      replace: options?.replace === true,
    });
  };
  const openCard = (cardId: string) => patchSearch((previous) => ({ ...previous, card: cardId }));
  const closeCard = () =>
    patchSearch((previous) => {
      const { card: _card, ...rest } = previous;
      return rest;
    });
  const openBoard = (parentCardId: string) => {
    const project = serializeBoardProjectScope(projectSelection);
    void navigate({
      to: "/board/$parentCardId",
      params: { parentCardId },
      search: project === undefined ? {} : { project },
    });
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BoardTopBar mode="list">
        <BoardCardFilterField onQueryChange={setQuery} query={query} />
      </BoardTopBar>
      <BoardListView
        costEmphasisUsd={boardSettings.display.costEmphasisUsd}
        accentNameFor={accentNameFor}
        allShells={allShells}
        attentionFor={attentionFor}
        environmentId={environmentId}
        inScope={inScope}
        keyPrefixFor={keyPrefixFor}
        onOpenBoard={openBoard}
        onOpenCard={openCard}
        projects={boardProjectScopePipelineProjects(projects, effectiveProjectSelection)}
        query={query}
        scopeControl={
          <BoardProjectFilter
            accentNameFor={accentNameFor}
            isHidden={(projectId) => isBoardProjectHidden(boardSettings, projectId)}
            onChange={(selection) =>
              patchSearch(
                (previous) => {
                  const { project: _project, ...rest } = previous;
                  const project = serializeBoardProjectScope(selection);
                  return project === undefined ? rest : { ...rest, project };
                },
                { replace: true },
              )
            }
            projects={projects}
            projectsLoaded={allProjects.length > 0}
            selection={projectSelection}
          />
        }
        shells={shells}
        stages={stageState}
      />
      {search.card !== undefined ? (
        <BoardCardDetail
          cardId={BoardCardId.make(search.card)}
          environmentId={environmentId}
          key={search.card}
          nav={null}
          onClose={closeCard}
          onOpenSubBoard={openBoard}
        />
      ) : null}
    </div>
  );
}

export default BoardListPage;
