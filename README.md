<p align="center">
  <a href="https://t3.codes">
    <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="T3 Code logo" />
  </a>
</p>

<h1 align="center">T3 Code</h1>

<p align="center">The open-source control plane for coding agents.</p>

<p align="center">
  <a href="https://t3.codes/download"><strong>Download</strong></a> ·
  <a href="https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824">iOS</a> ·
  <a href="https://play.google.com/store/apps/details?id=com.t3tools.t3code">Android</a> ·
  <a href="https://app.t3.codes">Web</a> ·
  <a href="./docs/README.md">Docs</a> ·
  <a href="https://discord.gg/jn4EGJjrvv">Discord</a>
</p>

<p align="center">
  <a href="https://t3.codes">
    <img src="./.github/readme/hero.webp" width="100%" alt="T3 Code on desktop with a finished Claude thread, next to the phone app asking to approve a command from Codex" />
  </a>
</p>

T3 Code runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, T3 Code can control it.

<!-- T3o: fork section. Upstream's README has no equivalent; keep fork additions together under this marker. -->

## This is T3o, a fork

This repository is **T3o**, a fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) that adds
**Board** mode: work is managed as cards moving through a fixed engineering pipeline (Backlog → Sprint →
Planning → Ready → Building → Code review → Ready for merge → Done), and the app spawns, supervises and
restarts the agent threads that do the work.

T3o is not published to any registry. `npx t3@latest`, the desktop installers and the package-manager
recipes under [Install](#install) all give you **upstream**, without the board. To run T3o you
build it from this checkout, on a tagged release from
[Releases](https://github.com/brentkelly/t3code-orchestrator/releases) (`t3o<T3 Code version>.<n>`).
Once installed as a service, `pnpm run t3o-update` moves it to the latest release.

### Requirements

- **Node.js 26.13.1** — `engines.node` is pinned to `26.13.1`. Distro packages are usually far
  older; use [nvm](https://github.com/nvm-sh/nvm), [fnm](https://github.com/Schniz/fnm) or
  [NodeSource](https://github.com/nodesource/distributions).
- **pnpm 12.14.0** — the workspace uses pnpm catalogs (the `catalog:` versions in `package.json`), which
  npm and yarn cannot resolve. An `EUNSUPPORTEDPROTOCOL` / `Unsupported URL Type "catalog:"` failure means
  the wrong package manager, not a broken lockfile.
- **A C++ toolchain** — `node-pty` ships no Linux prebuild and compiles during install. On Debian/Ubuntu:
  `sudo apt install -y build-essential python3`.
- **`git` and `rsync`**, plus `sudo` rights if you want the systemd service.
- **At least one provider CLI**, installed and authenticated as the user that will run the server. See the
  steps under [Sign in to an agent](#sign-in-to-an-agent).

### Install and build

```bash
corepack enable pnpm     # or: npm install -g pnpm@12.14.0
pnpm install             # not `npm install`, and not `--frozen-lockfile`
pnpm run build           # every app; the service install below builds the server on its own
```

`pnpm install` is what puts `vp` (Vite+, the build tool) at `node_modules/.bin/vp`. Until it has run, every
script in `package.json` dies with `node_modules/.bin/vp … ENOENT`, `install-t3o-service` included. The
global `vp` install described near the bottom of this file is optional — the repo carries its own copy.

### Run it as a service (Linux, systemd)

Install the provider CLIs first: the unit is written with a PATH resolved at install time, and a provider
that was not on your PATH then will fail to spawn with `ENOENT`. Re-run the install after adding one.

`pnpm run install-t3o-service` builds the server, copies the build to `~/.t3/app` so the service never runs
out of the worktree, and writes a `t3o.service` unit serving `http://127.0.0.1:3773` from your `~/.t3` data
directory:

```bash
pnpm run install-t3o-service                 # install, enable and start
pnpm run install-t3o-service -- --takeover   # ...and switch off whatever else holds the port
pnpm run t3o-service-status
pnpm run uninstall-t3o-service               # remove the unit, restore whatever --takeover displaced
```

`--takeover` only matters on a machine already running another T3 Code server (upstream's
`t3code.service`, say). On a fresh one, nothing holds port 3773 and the plain install starts straight away.

The pairing URL is printed once at startup, and you need it to reach the web app:

```bash
journalctl -u t3o.service -n 200 --no-pager | grep -i 'Pairing URL'
```

Do **not** use upstream's `t3 service install` here. It runs `npm install t3@<version>` against the public
registry, and would serve upstream's build against this fork's data — no board, and no error to say so.

Flags, updating to a new release, running without systemd, and troubleshooting:
[docs/t3o/install.md](./docs/t3o/install.md).

## What you get

- **Your subscriptions.** T3 Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads. There are apps for iOS and Android.
- **Remote ready.** Run agents on any machine. Connect over your local network, Tailscale, or [T3 Connect](./docs/user/remote-access.md).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Fast.** Performance is a feature here. We measure it, and we treat a dropped frame as a bug.
- **Open.** Source code is MIT licensed. If you don't like something, fork it under your own branding (see [Trademarks and forks](#trademarks-and-forks)).

## Install

### Desktop app

[Download T3 Code](https://t3.codes/download) for macOS, Windows, or Linux. You can also use a package manager:

| Platform       | Command                                                              |
| -------------- | -------------------------------------------------------------------- |
| macOS          | `brew install --cask t3-code`                                        |
| Windows        | `winget install T3Tools.T3Code` or `scoop install extras/t3code`     |
| Arch Linux     | `yay -S t3code-bin`                                                  |
| Nix            | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code`         |
| Debian, Ubuntu | `.deb` from [Releases](https://github.com/pingdotgg/t3code/releases) |

### Command line

This installs the `t3` command. Run `t3` to start the server and open the web app.

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

To try it once without an install, run `npx t3@latest`.

### Phone

Get the app from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code). Then follow [remote access](./docs/user/remote-access.md) to connect it to your computer.

### Sign in to an agent

T3 Code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install T3 Code](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork the source code and build the tool that you want, under your own name and branding.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

We have limited review capacity. Small, focused fixes are the most likely to be merged. Features need an approved discussion first.

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you report a bug or open a pull request.
- Put feature requests in [Ideas](https://github.com/pingdotgg/t3code/discussions/categories/ideas).
- Build from source with the [development runbook](./docs/operations/00_development.md#first-checkout). The [architecture overview](./docs/internals/01_architecture.md) explains how it works.
- Get help in [Discord](https://discord.gg/jn4EGJjrvv).

## License

The source code in this repository is licensed under the [MIT License](./LICENSE).

## Trademarks and forks

The MIT license applies **only to the source code**. It does not grant any rights to T3 Tools, Inc.'s trademarks, branding, or trade dress, including the **T3 Code** name, wordmark, logos, and application icons.

If you fork, redistribute, or build on T3 Code's source code:

- **Use your own branding.** Replace the T3 Code name, wordmark, logos, and application icons in any public fork, redistributed build, website, package, or app store listing.
- **Be explicitly clear that your project is unofficial.** Do not use the T3 Code name, wordmark, logo, or branding in your own projects without making it unmistakably clear that your project is unofficial and not affiliated with or endorsed by T3 Tools, Inc.

Using our name, wordmark, logo, or branding in a way that suggests official status or affiliation is trademark infringement and unlawful. **Any project indicating or implying that it is an official version of T3 Code when it is not will be pursued to the full extent of the law.**

See [TRADEMARK.md](./TRADEMARK.md) for the full trademark and branding policy.
