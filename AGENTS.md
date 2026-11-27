# T3 Code

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs and agents (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, Muse Code, fx) and serves web, desktop, and mobile clients.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

<!-- T3o: fork status and branch topology. Keep this block self-contained so upstream merges only ever conflict here. -->

## You are in T3o, a fork

This repository is **T3o** (`brentkelly/t3o`), a fork of
[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code). Everything below this section is upstream's
guidance and still applies. This section overrides it where they disagree.

T3o adds a **Board** mode alongside the stock Threads view: work is managed as cards moving through a
fixed engineering pipeline (Backlog → Sprint → Planning → Ready → Building → Code review → Ready for
merge → Done), and the app itself spawns, supervises and restarts the agent threads that do the work.
It is a supervisor, not a view.

**Read `.plans/t3o-00-overview.md` before making any T3o change.** It holds 22 locked architectural
decisions with their rationale and rejected alternatives. Per-feature specs are the numbered
`.plans/t3o-NN-*.md` files from `t3o-01` onwards; the build order and dependency waves are in the overview.

**Status:** the board is built and in use. Upstream is synced to `v0.1.13` (`T3O-144`); the
board reaches threads only through `board/ThreadGatewayV2.ts`. The
seam inventory and sync runbook are in `docs/t3o/seams.md`. The distributed board (`T3O-60`,
overview D19–D22) is built: one central server hosts the board and dials other T3o servers as
workers. The user-facing guide is `docs/user/board-workers.md`.

**Status colours are a fixed vocabulary.** Green means done and only done, blue means running,
violet (`--attention`) means waiting on a human, amber means blocked. Read
`docs/t3o/status-colours.md` before giving any status indicator a colour.

**Card automation is a contract.** Auto-plan, Unattended review, Auto sign-off, Auto-build and
Auto-merge each promise to move a card through a gate with no human step. Read
`docs/t3o/automation.md` before touching any gate, stage move or toggle.

**The design prototype** lives in `.plans/prototype/` and is published as a claude.ai design
artifact. The Docs MCP tools and plain fetches can't read it, but a headless browser can. When
asked to download or update the prototype, follow `docs/t3o/prototype-sync.md`.

### Plans are tracked here

Upstream's "Plans and work artifacts" section below says not to commit plans and gitignores
`.plans/`. **T3o overrides that: `.plans/` is tracked.** The fork's specs, locked decisions and
build order live there, the repo has no issue tracker of its own, and the plan-driven build flow
reads each file's frontmatter. `.gitignore` re-includes the directory directly beneath upstream's
ignore line. A commit that touches only `.plans/` needs `--no-verify`, because the format hook
fails on that directory.

The numbered `.plans/t3o-NN-*.md` series is the fork's own build order, not a template for how a
board card's plan should be shaped. A card's planning output is ONE plan unless the card genuinely
needs splitting — two or more plans means two or more child cards, behind a human approval gate.

### Branches — the rule that matters most

- **`t3o` is the working trunk and the default branch.** All work happens here. All PRs target it.
- **`main` is a pristine, fast-forward-only mirror of `upstream/main`. Never commit to it.** Its only
  job is to be conflict-free so an upstream sync can fast-forward. A single commit on `main` breaks
  that permanently, and the sync is meant to fail loudly rather than force.
- Upstream is merged (never rebased) into `t3o` from `main`, **manually and on demand** — there is
  no sync automation during MVP. The runbook is in `docs/t3o/seams.md`.

### Touching upstream-owned files

The fork's survival depends on keeping the diff into upstream files small, mechanical and greppable.

- Every insertion into an upstream-owned file is preceded by a **`T3o:`** marker comment naming the
  reason. Lowercase `o` — `T3O` reads as `T30`.
- Prefer a one-line delegating call into a T3o-owned module over inline logic. If a seam is growing
  past a few lines, it belongs in our own file.
- New files never conflict. Reach for a new file before editing an existing one.
- Board database migrations live in **`apps/server/src/board/migrations/`**, numbered from `001`,
  and run against their own ledger table (`t3o_sql_migrations`) via `runBoardMigrations()`. Add
  `NNN_Name.ts` there and append it to `BOARD_MIGRATIONS`. Never put a board migration in
  upstream's `persistence/Migrations/`: effect's `Migrator` advances one high-water mark per
  ledger table, so a board migration sharing upstream's table silently skips every
  lower-numbered upstream migration — data loss, not a merge conflict. The two lineages are
  independent by design; see `docs/t3o/seams.md`.
- Do not rename the `@t3tools/*` workspace packages. They are `private: true` and resolved through
  `workspace:*`, so nothing is fetched from NPM and renaming would touch every import for no gain.

<!-- T3o: end fork block -->

## What makes T3 Code special?

We have over 500,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks (our MIT license covers source code only, not T3 Code's trademarks or branding; see [TRADEMARK.md](TRADEMARK.md)). We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of T3 Code's websocket layer (`t3`) enables a lot of awesome remote features. These have become core to the product. Whether users are connecting directly over their local network, using Tailscale, or leaning in fully with T3 Connect (our tunnel solution, also in this repo), we need to make sure new features are properly supported.

### 4. Multi-surface

T3 Code has 3 key app surfaces: **web**, **desktop**, and **mobile**.

**Web** is kind of two surfaces, as we have the public facing "app.t3.codes" as well as locally hosting the web app through the `t3` command. Both need to be supported by all new features where reasonable.

**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from app.t3.codes or the mobile app.

**Mobile** is a React Native app for both iOS and Android, available on the App Store and Google Play. The mobile app allows for connecting to any T3 Code server to control work remotely.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.

## Terminology

- **you** = the agent reading this file. **we / us / maintainers** = Theo, Julius, and the people building T3 Code. **user** = person driving coding agents in T3 Code. **agent** = coding agent running inside T3 Code.
- Domain terms (environment, project, thread, turn, provider, checkpoint, etc.): [00_glossary.md](docs/internals/00_glossary.md).

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading or copying from it is fine. Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** Chat view, Settings, command palette, and keybindings. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (Electron shell/IPC), and mobile (React Native). Shared logic lives in `packages/client-runtime`.
- **Providers.** Every provider adapter needs a decision, even if the decision is "not supported here".
- **Agents.** Capabilities a user triggers should be service methods reachable by MCP tools and scheduled tasks, not inline handler code.
- **Contracts.** Wire changes go in `packages/contracts` so server, web, mobile, and desktop follow.
- **Reverse states.** Every way in needs a way out and a way to see it (snooze/unsnooze, close/reopen). A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel; multi-device and multi-environment.
- **Languages.** Translate user-facing copy in `apps/{web,mobile}/src/i18n/translations` (`vp run i18n:generate` / `vp run i18n:check`) and `apps/marketing/src/i18n`. See [14_i18n.md](docs/internals/14_i18n.md).
- **Docs.** Check whether the change makes existing guidance inaccurate. Follow [Documentation](#documentation).

## Dev servers and test data

See [00_development.md](docs/operations/00_development.md) for setup, ports, seeding (`vp run migrate-dev-db`), and [reusable dev auth](docs/operations/00_development.md#reusable-dev-credential). Agent-specific rules:

- **Worktree setup:** Wait while `.t3/setup-running` names a live PID; do not run `vp i` concurrently. If no `.t3/setup-*` marker exists, run `vp i` yourself.
- **Process lifecycle:** Start dev servers, Metro, and builds from your own shell so they exit with your session—never detach with `systemd-run`, `nohup`, `setsid`, or `tmux` unless asked. Stop background tasks with your harness's own stop (`vp` does not forward SIGTERM to child Vite/server processes).
- **Sharing (`vp run dev --share`):** Wait for `pairingUrl:` and hand the full URL to the user. Never wire `tailscale serve` by hand, open the URL yourself, or consume the user's one-time pairing link. Mint another with `node apps/server/src/bin.ts pair` if needed.
- **Test data:** Always copy in (never symlink) and refresh `statev2.sqlite`, not `state.sqlite`. Bring `secrets` / `settings.json` only if the flow under test needs them.
- **Extra checkouts:** Put `git worktree add` next to this worktree, not in `/tmp`, and remove it when done.

## Verifying

- Before you push, run scoped checks on what you touched: `vp fmt <files>`, `vp lint <files>`, `vp test run <your test files>`, and the typecheck below. When you add, remove or move exports or files, also run `vp run knip:check` (~15–25s). In a turn, never run `vp run check:changed`, whole directories, whole packages or the full server suite; `vp test run --project board` (~45s, from `apps/server`) is fine for board-wide changes. The board's CI stage runs `scripts/t3o-ci.ts` once per pass; never run it or `vp run t3o:test-full` yourself. <!-- T3o: was "run `vp run check:changed`"; it re-tested the whole fork diff every turn (T3O-88). -->
- **Do not run repo-wide checks** (`vp check`, `vp run -r test`, `vp run -r typecheck`) unless asked; `vp run knip:check` is the one exception. The board's CI stage owns the full suite. <!-- T3o: knip carve-out and "board's CI stage" (T3O-88). -->
- `vp` lives in `node_modules/.bin`: if it is not on `PATH`, use `node_modules/.bin/vp …` (`pnpm exec` rewrites `pnpm-lock.yaml` on some machines), and run `vp i` when `node_modules` is missing. Run anything long with `run_in_background` and `t3_background_wait`, never `timeout` or `sleep` polling. <!-- T3o: T3O-88 -->
- Iterate with `vp test run <files>` (add `-t "<name>"` for large files). Typecheck the changed package and its dependents with `vp run --filter '...<package-name>' typecheck` (leading `...` = dependents; a contracts change must not wait for CI to find a web or server break); it caches per package. <!-- T3o: was "Use `vp run typecheck`" (T3O-88). --> Each package runs `effect-tsgo tsrs --noEmit`. Run `node -e` snippets from the owning package (`effect` does not resolve from repo root).
- Follow [15_testing.md](docs/internals/15_testing.md) for what to test, bug-fix proof, draining async work (no sleeps/polling), web browser tests (`await using screen = await render(...)`), and real-app [Scenarios](docs/internals/15_testing.md#scenarios) (`vp run scenarios:prove`).
- Give user-visible frontend changes one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile (primary agent only; subagents do not launch dev servers). Inspect the rendered result and walk the flow as a user using the feature—checking layout, visual hierarchy, and ergonomics—and fix anything rough until you are satisfied before handing back. Use the free `Replay (dev)` provider unless the change depends on a real provider (then pick its cheapest model, e.g. Haiku or Luna). On mobile, run `vp run mobile:install <ios|android> [device-id]` before Metro rather than rebuilding from scratch.

## Evals

`evals/` checks how real models behave with T3 Code's model-facing text: agent instructions, MCP tool descriptions and schemas, and generated titles. Before changing that text, read [evals/README.md](evals/README.md) and run the evals it names. When fixing a model behavior bug, add a case that fails before the fix.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- `origin` is not always GitHub. Check `git remote get-url origin` before your first forge command and use that forge's CLI and skill. See [Forge mirror](docs/operations/00_development.md#forge-mirror-optional).
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- **Rebase onto latest `t3o` before opening.** Stale branches conflict and burn a review round.
  <!-- T3o: upstream dropped this rule; in this fork `main` is an upstream mirror and `t3o` is the trunk. -->
- **PRs target `t3o`, never `main`.** The one exception is the `main → t3o` upstream sync, which is
  run by hand from the runbook in `docs/t3o/seams.md`. <!-- T3o: fork PR-target rule — upstream's text targeted `main`. -->
- UI changes need before/after images; motion or timing needs a short video. Upload PR evidence to GitHub—never commit PR-only screenshots or assets.
- One request is one PR. Split only when asked. Outside contributions follow [CONTRIBUTING.md](CONTRIBUTING.md#one-problem).
- When babysitting: call `watch_pull_request` and end your turn. Do not poll or sleep. Verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new; stop when bots are green on the latest commit.

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields, methods, constants, timeouts, or migration numbers, narrate control flow, maintain file catalogs, or append PR summaries. Anything that can drift will drift; types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index.
- A local reason the code can't show goes in a short nearby code comment. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks in the shipped product's voice, without implementation details or contributor tooling. Focus on what a feature does, how to start, and anything unintuitive—not descriptions of buttons, layouts, or UI tweaks.
- `docs/operations/` holds maintainer setup, release, and debugging runbooks. Keep end-user server instructions in `docs/user/`.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files (keep temporary material outside the worktree).
- Track active maintainer work in its GitHub issue or project item; external proposals belong in Ideas discussions. A merged PR is the implementation record.

## Where code lives

- `apps/server` - WebSocket, event-sourced orchestration (`Orchestrator` → `EventSink` → `EffectWorker`), providers, checkpointing. Read [02_effect-services.md](docs/internals/02_effect-services.md) and `.repos/effect/LLMS.md`.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it; `apps/mobile` is React Native; `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema wire contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client connection and domain state shared by web and mobile.
- `.repos/` - vendored read-only references. Never edit or import from them (`vpr sync:repos` updates them; if sparse-checked-out, read via `git show origin/main:.repos/<path>`).

### Internal docs by area

Read the matching doc before changing code in that area; code review enforces them.

| Area                                       | Read first                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture & orchestration               | [00_glossary.md](docs/internals/00_glossary.md), [01_architecture.md](docs/internals/01_architecture.md)                                                                                          |
| Server Effect services & errors            | [02_effect-services.md](docs/internals/02_effect-services.md)                                                                                                                                     |
| Providers & ACP                            | [03_providers.md](docs/internals/03_providers.md)                                                                                                                                                 |
| Auth, MCP, guest links, assets, security   | [04_environment-auth.md](docs/internals/04_environment-auth.md), [SECURITY.md](SECURITY.md)                                                                                                       |
| Remote routes, peer links, previews        | [05_remote.md](docs/internals/05_remote.md)                                                                                                                                                       |
| T3 Connect & relay                         | [06_t3-connect.md](docs/internals/06_t3-connect.md)                                                                                                                                               |
| Server updates & crash recovery            | [07_server-updates.md](docs/internals/07_server-updates.md)                                                                                                                                       |
| Telemetry & analytics                      | [08_product-analytics.md](docs/internals/08_product-analytics.md)                                                                                                                                 |
| Client connection & sync runtime           | [09_connection-runtime.md](docs/internals/09_connection-runtime.md)                                                                                                                               |
| Web UI primitives, styles & React Compiler | [10_web-ui.md](docs/internals/10_web-ui.md)                                                                                                                                                       |
| Mobile layout, navigation & dev lifecycle  | [11_mobile-layout.md](docs/internals/11_mobile-layout.md), [12_mobile-navigation.md](docs/internals/12_mobile-navigation.md), [13_mobile-development.md](docs/internals/13_mobile-development.md) |
| Translations & UI copy                     | [14_i18n.md](docs/internals/14_i18n.md)                                                                                                                                                           |
| Writing & reviewing tests                  | [15_testing.md](docs/internals/15_testing.md)                                                                                                                                                     |
| Wire budgets, server metrics & perf        | [16_performance-regressions.md](docs/internals/16_performance-regressions.md)                                                                                                                     |
| Repo & package scripts                     | [17_scripts.md](docs/internals/17_scripts.md)                                                                                                                                                     |

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Client mutations use `createEnvironmentRpcCommand`, declare protected methods in `CLIENT_GUARDED_RPC_SCOPES`, and gate UI with `permissionAtom` (server stays authoritative). Keep raw RPC clients inside `rpc/`.
- Server features are Effect services using `Effect.fn("Service.operation")` with thin transport handlers; see [02_effect-services.md](docs/internals/02_effect-services.md).
- `apps/web/src/components/ui` exports own their look (`shadcn/no-restyle` enforces this); see [10_web-ui.md](docs/internals/10_web-ui.md).
- Inferred types over annotations. `any` is the enemy.
- Default to no comment. Write one only for a constraint, external quirk, or invariant the code can't show (1–4 lines max; `t3code/no-low-value-comments` enforces this).
- React effects are only for synchronizing with external systems. Derive in render and act in handlers; any remaining effect states its reason via `// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <why>`.
- No continuously repainting animations; they peg the GPU on high-refresh displays.
- Security matters, but do not over-index on dev-mode or maintainer-only features. Read [SECURITY.md](SECURITY.md) before auditing or triaging reports.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.
