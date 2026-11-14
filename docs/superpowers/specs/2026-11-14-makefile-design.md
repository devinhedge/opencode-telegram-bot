---
title: Makefile Design
status: draft
version: 0.1.0
last_updated: 2026-11-14
review_date: 2027-05-14
branch: feat/make-installer
depends_on: uninstaller feature (docs/superpowers/specs/2026-11-11-uninstaller-design.md, decisions 16, 17, 18, 20), merged into feat/core-feature-expansion through pull request 5
---

# Makefile Design

The `Makefile` at the repository root gives macOS and Linux users one set of commands for installing and operating the bot from a checkout. This document covers the targets that exist now, `help` and `install`, and the rules every target follows. The other targets are separate work.

## Goals

- `make install` installs the `opencode-telegram` command from the checkout in one step, with no setup questions.
- `make help` lists every target that exists.

## Non-goals

- Windows. The README gives the npm commands there.
- Setup. `opencode-telegram config` configures the bot; `make install` never runs it.
- The `config`, `start`, `stop`, `restart`, and `uninstall` targets (see "Later targets").
- Installing from the npm registry. `npm install -g @grinev/opencode-telegram-bot` stays the registry route.

## Rules for every target

- Targets run as the invoking user. A target that changes the installation refuses to run as root. `help` runs as root too.
- A refusal happens before any other command in the recipe runs.
- No target needs `sudo` up front. `help` and `install` use none; `sudo` appears only in the `uninstall` command's systemd steps (uninstaller decision 20).

## Targets

### help

The default target (`make` with no target runs it). It prints the usage line and one line per existing target: the name and a one-sentence description. It changes nothing.

### install

Runs, in order, from the repository root:

1. `npm ci`: installs the dependencies exactly as `package-lock.json` records them, without rewriting it.
2. `npm run build`: compiles TypeScript to `dist/`.
3. `npm link`: links the checkout globally, so the `opencode-telegram` command (the `bin` entry `dist/cli.js`) runs this checkout's build.

A failing step stops the target. The root refusal is a Makefile `$(error ...)` that expands before step 1, so a dry run (`make -n install`) shows it and a refusal exits non-zero without running npm.

The link, not a registry install, is what `make uninstall` later removes (uninstaller decision 17). An existing global install of the same package can conflict with the link; `make install` does not remove it and reports npm's error.

## Later targets

Decided in the uninstaller spec and not designed here:

- `config`, `start`, `stop`, `restart`: wrappers over the matching `opencode-telegram` commands.
- `uninstall` (decisions 4, 17, 18): stops the daemon, runs `opencode-telegram uninstall` from the checkout's built `dist/cli.js` so it works when the global install is broken, and removes the link `make install` made. The symlinks are removed by `lstat` on the path and never resolved, because `npm link` may leave them dangling.

Each later target extends `help` with its own line.

## Test approach

`tests/makefile.test.ts` runs `make` only as a dry run (`-n`) or as the print-only `help`, so no npm command executes. It asserts the default target, the help lines, the install step order, the absence of the config wizard, and the root refusal (the user id is overridden through the `CURRENT_UID` variable). The test is skipped on Windows. Running `make install` for real is a manual check on a disposable account, because it replaces `node_modules` and links a command globally.
