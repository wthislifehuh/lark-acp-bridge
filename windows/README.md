# Windows one-click launchers

One `.bat` per built-in agent preset — double-click instead of opening a terminal and typing the `lark-acp proxy --agent <preset>` command yourself. Each one:

1. `cd`s to the repo root (so it works no matter where you double-click it from).
2. Builds the project automatically on first run if `dist/` is missing (`npm run build`).
3. Starts the bridge with that preset, and `pause`s at the end so the window doesn't vanish if it exits/crashes.

| File                   | Preset         | Notes                                                                      |
| ---------------------- | -------------- | -------------------------------------------------------------------------- |
| `run-claude.bat`       | `claude`       | Needs `claude` CLI logged in once (`claude` in a terminal).                |
| `run-claude-agent.bat` | `claude-agent` | Needs `ANTHROPIC_API_KEY` — warns if it's not set in the environment.      |
| `run-codex.bat`        | `codex`        |                                                                            |
| `run-copilot.bat`      | `copilot`      |                                                                            |
| `run-gemini.bat`       | `gemini`       | See main README's [Connecting Gemini](../README.md#connecting-gemini).     |
| `run-opencode.bat`     | `opencode`     | Warns if `opencode` isn't on `PATH`.                                       |
| `run-kiro.bat`         | `kiro`         | Warns if `kiro-cli` isn't on `PATH`. Native Windows support since CLI 2.0. |
| `run-q.bat`            | `q`            | Different shape — see below, Amazon Q only runs under WSL.                 |
| `run-mock.bat`         | `mock`         | Scripted agent, no real model calls — good for testing your Feishu setup.  |

`_prepare.bat` is shared plumbing (the build-if-missing step); it's not meant to be run directly.

## Prerequisites (all launchers)

- Node.js 20+ on `PATH`.
- Feishu/Lark app credentials configured — either `~/.config/lark-acp/config.json` (or `%USERPROFILE%\.config\lark-acp\config.json` on Windows) or the `LARK_ACP_APP_ID` / `LARK_ACP_APP_SECRET` environment variables. See the main [README](../README.md#feishulark-developer-console-setup).
- Whatever the chosen agent itself needs (its own CLI installed/logged in, or an API key) — see the per-agent notes above and the main README's "Connecting X" sections.

## `run-q.bat` is different

Amazon Q has no native Windows build, so this one can't just run `node` directly on Windows — it builds on the Windows side (the build output is plain JS, safe to share), then hands off to a Node process running **inside WSL**, where `q` actually lives. It resolves the repo's WSL-side path automatically via `wsl wslpath`, so it doesn't matter what your WSL username or distro is named.

One-time setup before this works — see the main README's [Connecting Amazon Q](../README.md#connecting-amazon-q) section:

1. Install WSL if you haven't (`wsl --install`).
2. Install and log into `q` **inside WSL** (not Windows).
3. Install Node.js **inside WSL** too — it's a separate installation from the Windows one; `dist/` and `node_modules/` are pure JS and safe to share across both, but the `node` executable itself is not.

## Customizing

These are thin wrappers — to pass extra flags (e.g. `--hide-thoughts`, `--permission-mode alwaysAllow`), just edit the `node dist\bin\lark-acp.js proxy --agent <preset>` line in the relevant file, or add a `proxy --agent <preset> -- <extra-args>` per the main README's CLI reference. To add a launcher for a custom preset you defined in `config.json`, copy any `run-*.bat` and change the `--agent` value.
