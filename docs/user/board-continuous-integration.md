# Continuous integration

A project can have the board run its CI on every card after Code review and before Ready for merge.
Set it up on the project's page: **Settings** → **Board** → the project → **CI**. A card in CI links
there from its CI tab.

## Steps

Turn on **Run CI for this project**, then add steps. They run in order:

- **Script**: a shell command run in the card's worktree. Its exit code decides pass or fail. It's
  stopped and fails after its timeout (30 minutes unless you set it, at most a day).
- **Agent**: a prompt an agent runs in its own thread, for checks a command can't make. The board
  adds what the agent needs (the card, its branch and pull request, earlier results) and how to
  report. Like every CI step it checks the branch without changing it: what it finds goes to the fix
  agent.
- **Forge checks**: waits for the pull request's checks on GitHub, GitLab, Bitbucket or Forgejo. A
  draft pull request is marked ready first. You can wait on named checks only (`*` matches anything),
  and choose whether a pull request where no checks appear passes or fails. Without an open pull
  request, or on a forge with no checks API (Azure DevOps, GitCafe), the card waits for you.

A script marked **Parallel with previous** starts together with the script before it; the group
finishes before the next step starts. Scripts in one
group share a worktree, so they can collide on build output or caches. Agent and forge-check steps
always run on their own. A group that leaves changes to tracked files fails. A project can have at
most 12 steps.

Scripts run in the card's worktree as they are, so install what they need in the command.

## Stop on failure

**Stop on failure** on the CI tab decides what a failed step does to the steps after it:

- **Yes** (the default): a failure stops the steps after its group. Passes end sooner, but one pass
  may show only the first failure, so finding the rest can take several fix rounds.
- **No**: every step runs even after one fails, and the pass fails at the end if any step did. One
  pass shows every failure, and the fix agent gets all of them at once. Passes take longer.

Choose **No** when you want several steps for their status and timings on the card and still want
every failure from one pass. Steps still run one after another, never side by side. Skip CI, moving
the card out of CI and a pass that can't run still stop everything. A change applies from the next
pass.

## Reporting from a script

Only the exit code is required. A script can also:

- print progress lines, which stay in the step's log:
  `echo '::t3o-progress::{"message":"Running unit tests","done":128,"total":212}'`. The step shows
  the latest message, count and bar, and the card shows the count instead of a timer. Any field can
  be left out.
- print a failure line saying what failed and why, which becomes the step's headline:
  `echo '::t3o-failure::{"step":"lint","reason":"No files matched src/**"}'`. `step` (the sub-step),
  `machine` and `flaky` are optional; the first failure line a step prints is the one used.
- write a result file at `$T3O_CI_RESULT` before it exits, with a summary and failures the CI tab
  and the fix agent show. Mark a failure `"machine": true` when the machine, not the code, is to
  blame (a missing browser library, say). Mark it `"flaky": true` when the script re-ran it on its
  own and it passed, with the command that re-runs it in `"repro"`:

```sh
cat > "$T3O_CI_RESULT" <<'JSON'
{ "summary": "3 of 212 tests failed",
  "failures": [{ "title": "slow_consumer_drops_oldest", "detail": "dropped frames",
                 "file": "src/fanout.rs", "line": 311 }] }
JSON
```

The result file adds detail only, with one exception: a step whose every reported failure is marked
`flaky` passes (see **Flaky tests**). It never turns a passing exit code into a failure.

## When a step fails

A failed step gets a headline at the top of the CI tab and on the card: what failed (the step, or
"step → sub-step") and why, with **Show in log** opening the log at that line. The reason is, in
order: the script's `::t3o-failure::` line or a result-file failure marked `machine`, a machine
problem in the output, the result file's first failure, a tool that stopped outright (such as "No
files matching the pattern" or "Cannot find module"), the first error line near the end of the
output, the last line of output, and finally the exit code or time limit. Only the failed step's own
output is read.

**Machine problems** are held for you instead of being handed to a fix agent: a missing system
library, no space left on the disk, a read-only filesystem, a command that isn't installed (exit
127), and a step the system killed: "Killed" or "Out of memory" in its output, exit 137 or SIGKILL,
and no time limit reached. The card shows **Machine problem** in amber, naming the machine and what
to fix there. No fix attempt is used:
fix the machine, then press **Retry CI**. A script's own `machine` flag always wins: `false` keeps a
failure with the code even when its output looks like a machine problem.

Any other failure goes to a fix agent. It gets every failure the pass reported, each told what failed
and why first, as a numbered list of issues, and fixes them on the card's branch. Then every step
runs again from the top. CI never sends a card back to Code review by itself.

**Fix attempts** caps the fix agents one visit to CI may start (5 by default). When they run out, or
the fix agent reports something it can't fix, CI stops and the card waits for you, marked **Needs
you** with the reason: **Retry CI** starts over with fresh attempts, **Send back to review anyway**
sends the card to Code review with every failure as a must-fix finding, and **Skip CI…** moves it
on. Defaults are in **Settings** → **Board** → **Pipeline** → **Continuous integration**; each
project can override them on its **CI** tab, under **Fix agent**.

## Flaky tests

A flaky test never stops a card. A failure counts as flaky when:

- the script marks it `"flaky": true` (or its `::t3o-failure::` line says `"flaky": true`). If every
  failure of a step is flaky, the step passes then and there, with an amber **flaky** marker in the
  CI tab. A step with flaky failures beside real ones fails as before, and the fix agent is told the
  flaky ones aren't its to touch.
- the fix agent re-runs the failing test on its own and it passes. If every failure was a flake,
  the same pass carries on from the step after it, and no fix attempt is used. This check also runs
  once the fix attempts are used up, before CI stops for you.

A test that flaked once in a visit to CI passes with no agent if it flakes again in that visit.

A flake on a calm machine is probably a real race. Each one becomes a low-priority **bug card** in
the same project, labelled `bug`, with Auto-plan, Auto sign-off and Auto-build on but not
Auto-merge: you come back to a fix ready to merge (unless Auto-merge is on for the whole board,
which merges every card). Its brief names the test, how to re-run it, the error and the card it
flaked on. Tests are matched by their exact `file › title`, so a test that flakes again adds a note
to its open bug card instead of making a second. At most 3 new bug cards are filed per pass and none
once a project has 10 open; the rest are listed on the card that flaked. A bug card's own test is
never treated as flaky on that card, with one exception under load (see **Running under load**).

A flake on a busy machine files no card: the test goes onto the project's load-sensitive list
instead (see **Running under load**).

## Running under load

On a busy machine any end-to-end test can run past its time limit, and a failure there says nothing
a card could fix. CI tells each script step how busy the host is, and hands it the tests that have
flaked under load before, so the script can leave them to the project's nightly run.

- `T3O_CPU_PRESSURE` is the host's CPU pressure as a whole percent (`/proc/pressure/cpu`, the larger
  of the 10- and 60-second averages), read just before the step's group starts. It's unset when the
  machine can't say (not Linux).
- `T3O_UNDER_LOAD=1` is set when that pressure is above the project's **Under-load threshold** (50 %
  by default). The step's row in the CI tab shows the reading, in amber when under load.
- `T3O_CI_LOAD_SENSITIVE` is the path of a JSON file listing the project's load-sensitive tests, as
  `[{ "file": "e2e/checkout.spec.ts", "title": "pays with a saved card" }]`, `[]` when there are
  none. It is a snapshot taken once per run, so every step of a pass reads the same list. Treat a
  missing variable as an empty list, and match on the exact `file` and `title` your script reported.

Both settings are on the project's **Resources** tab, or in `t3o.json` under `resources`:
`ciLoadThreshold` (percent) and `ciCpuCores`, the cores a CI pass asks its worker for while it runs
(say 8 for a suite that runs 8 browsers). The larger reservation is best effort: when the cores
aren't free, the pass runs on the card's own reservation rather than waiting.

**The load-sensitive list.** A test that the script reports `flaky` in a step that ran under load,
or one of its failures that the fix agent finds passes alone, goes onto the list, and no bug card is
filed for it; the card it flaked on gets a note. A flake the script never named (the fix agent's
ruling on a whole step) is only noted, since no entry could match it. An entry
expires 14 days after the test's last flake under load, and each new one gives it another 14 days.
Since a listed test is skipped while the machine is busy, it usually leaves the list 14 days after it
joined, and rejoins with no card on its next busy flake. The list holds at most 50 tests; past that
the oldest is replaced. A full list means the threshold is too low for this machine or CI is
oversubscribed. A flake with no file (a whole-step failure line) is only noted. A bug card's own test
is never on its own CI's list. See the list, remove a test or clear it on the project's **CI** tab,
under **Load-sensitive tests**.

**What your script does with it.** The board knows nothing about your test runner, so these are the
script's duties:

- Skip listed tests only when `T3O_UNDER_LOAD=1`.
- Never skip a listed test whose spec is in the card's change, or which covers a changed file. Only
  the script can map tests to files, and skipping one would let a card break it and merge green.
- Under load, never report a failure in such a test as `flaky`: it is a real failure of the card.
- Report every test you skipped as `deferred` in the result file:
  `"deferred": [{ "file": "e2e/checkout.spec.ts", "title": "pays with a saved card" }]`. The CI tab
  shows "N load-sensitive tests deferred to the nightly" in grey, a passing pass reads
  "Passed · N deferred", and the card gets a note listing them.

The result file's older `"loadSensitive": true` mark and test tags in code are no longer needed; the
board ignores the mark and keeps the list itself.

**Run a nightly on a quiet machine.** The nightly is what covers deferred tests, so run it with a
pinned worker count when the machine is otherwise idle, never skip listed tests there (it may run
them with repeats to catch races), and report its failures somewhere a person sees them, or file a
card. The board doesn't hold CI for a nightly: it has no idea which run that is.

**Known gap.** The reading is taken before each step group. A spike from other CI that starts during
a step goes unseen, so a flake then files a low-priority bug card as on a calm machine. If a step does
long setup before its heaviest part, re-read `/proc/pressure/cpu` there.

**Turning it off.** A threshold of 100 means the machine is never busy: no step is told
`T3O_UNDER_LOAD`, nothing is skipped or listed, and every flake files a bug card. An empty list only
stops the skipping.

On a bug card's own CI, under load, its target test may be reported flaky. If the card won't be
merged automatically, the step records the test as inconclusive under load and the card goes on to
you to merge; put the re-measured timings in the pull request. Otherwise the test must pass.

Recommendations:

- Under load, judge a test that timed out by one solo re-run on one worker: it is `flaky` only if it
  passes within its own normal timeout. Otherwise report a real failure: a broken page often looks
  like a timeout.
- Don't report a load-born failure that isn't a test (a server that boots slowly, a lock wait) as
  `"machine": true`, which holds the card for you. Retry or wait longer in the script instead.

## Following a run

The card's **CI** tab shows each step, how long it took, a failed step's output and reported
failures, an agent step's thread, a forge step's checks, the fix agent at work, and earlier passes.
A failed pass ends with a **Fix failures** row listing each issue; once the fix agent reports, each
shows as resolved or can't fix.

- A running script shows its time against its limit, such as "Running 12 / 60 min", and its progress
  if it prints any. The card catches up about every 10 seconds, and a failed step keeps the last
  progress it reported, so you can see where it stopped.
- A running script that has printed nothing for 10 minutes shows "No output for N min". It's only a
  warning: the step keeps running until it finishes or reaches its limit.
- **View live log** on a running script, or **View log** on a finished one in any pass, opens its
  output. A running step's log follows new output; scroll up to pause, and **jump to latest** to
  follow again. Colours are kept. **Copy** copies what's shown, and **Download** saves the whole
  log. The viewer holds the last 2 MB or so of a long log; Download always has all of it. This
  works the same for a card on a worker.
- Each pass's log folder, `.t3/ci/<runId>/` in the card's worktree, is shown under the pass with a
  copy button, for opening in a terminal. The board keeps it out of git. When the worktree is
  removed, its logs go with it, and the viewer says the log is no longer available.

## Can't run, Stop CI, Skip CI and turning CI off

When a pass can't run, the card shows **Can't run** with the reason: no worktree, a worker out of
reach or whose connection closed mid-run, no pull request for a forge step, or a CI script that
stopped without its result being saved. The board notices a pass with nothing left running within
about a minute, so a crashed or killed script never leaves a card stuck on running. Fix what's in the
way and press **Retry CI**, or **Skip CI…**, which moves the card to Ready for merge without a
passing run and records the skip under your name.

Before a pass runs, the board checks that the disk holding the card's worktree, and the disk holding
the T3 Code data on the server running the board, each have at least 2 GiB free. If not, the card
shows **Machine problem** with the free space on that machine, and no fix agent starts: free some
space, then press **Retry CI**.

**Stop CI**, in the CI tab's header while a pass is queued, running or being fixed, stops it: running
steps and any CI agent are stopped, and the card waits with "Stopped by you" until you press Retry
CI.

Retry CI, Stop CI, Send back to review anyway, Skip CI and skipping a step are for people only;
agents can't press them.

Turning **Run CI for this project** off asks first when cards are in CI: they move on to Ready for
merge with auto-merge off. Removing every step does not turn CI off: cards already in CI wait until
you add a step and retry, and new cards skip CI.

## Skipping a step

While a pass is queued or running, each step that hasn't finished has a **Skip** button in the CI
tab. On a running step it stops the step and the pass carries on from the next one. On a step that
hasn't started, it marks the step "Will be skipped", and the pass skips it when it gets there;
**Unskip** takes the mark off any time before then.

- A skip lasts until the card leaves CI: the re-run after a fix, and Retry CI on a held pass, skip
  it too. Retry CI on a stopped card, or the card's next time through CI, runs every step again. A
  step skipped while it ran can be unskipped on the next re-run.
- A skipped step is not a failure. A pass whose other steps pass is a pass, shown as "Passed · 1
  skipped", and Auto-merge still runs.
- You can't skip every step: use Skip CI for that.
- Skipping a step that runs in parallel with others restarts the others in its group. Its group
  If the skipped step sits in the middle of its group, the group then runs in two parts, the steps
  before it and then the steps after it, for the rest of the card's time in CI, so it takes longer.
- Skipping a step later steps depend on, such as an install or a build, can make them fail. That's
  a real failure, and the fix agent sees it, along with which steps you skipped.

## Moving cards by hand

Cards enter CI on their own when Code review finishes, and leave it by passing or by Skip CI. You can
move a card into CI yourself only from the stage just before it, and you can't move a card past CI.
You can still move a card out of CI back to an earlier stage.
