# tg-claude-code

Run [Claude Code](https://claude.com/claude-code) from Telegram — full agentic
sessions, approval gate, live progress, GitHub, public tunnels, voice input —
driven from your phone instead of a terminal.

Originally built to let one person drive Claude Code entirely from a VPS over
a slow/metered mobile connection, without needing a PC open. Multi-session,
subscription-primary with an OpenAI-compatible-proxy fallback, and every
provider isolation rule needed to avoid mixing incompatible API transcripts.

## What it does

- **Multi-session** — `/new`, `/switch`, `/kill`; each session is its own
  working directory + isolated Claude Code state, so unrelated projects never
  bleed into each other's context.
- **Real approval gate** — `APPROVAL_GATE=1` makes the bot ask before every
  write/edit/shell command, with inline Telegram buttons — the same prompt
  flow as running Claude Code in an interactive terminal, just over chat.
- **Cost controls** — `/compact` (Claude's own summarization), `/renew` (hard
  reset, keeps files), a `--max-turns` cap on unsupervised iterations, a
  deny-list for destructive commands (`rm -rf`, force-push, etc.), context-size
  tracking with a nudge before a session gets expensive.
- **Live feedback** — a "⚙️ Working — <current step>" status line that updates
  as the agent works, instead of silence until the final reply.
- **Fallback provider** — automatic failover to an Anthropic-API-compatible
  proxy (e.g. [AgentRouter](https://agentrouter.org)) when the primary
  subscription is rate-limited, with strict session isolation so a
  proxy-shaped transcript is never resumed under the real API (see
  [ARCHITECTURE.md](./ARCHITECTURE.md) for why that matters).
- **GitHub-native** — commits/pushes as your account via `gh`, no
  Claude co-author trailer.
- **Public tunnels** — `/tunnel` (managed, one site) or let Claude run its own
  named background servers/tunnels via `scripts/daemon.sh` for multi-project
  sessions — get a public `*.trycloudflare.com` URL without loading anything
  on your phone.
- **Extras** — photo/PDF upload, voice-note transcription (whisper.cpp),
  `/preview` screenshots via headless Chromium, disk-usage tooling
  (`/disk`, `/archived`, `/purge`), a self-service subscription-token flow
  (`/reauth`, `/setuptoken`) so re-authenticating never needs a terminal.

## Quick start

Requires a VPS (or any always-on Linux box) with Node.js 20+, the
[Claude Code CLI](https://claude.com/claude-code) installed and authenticated,
and a Telegram bot token from [@BotFather](https://t.me/BotFather).

```bash
git clone https://github.com/<you>/tg-claude-code.git
cd tg-claude-code
npm install

cp .env.example .env
$EDITOR .env   # TELEGRAM_BOT_TOKEN, ALLOWED_TELEGRAM_USER_ID at minimum

node src/index.js
# In Telegram: /new test, then a prompt — confirm you get a reply.
```

Then run as a service so it survives reboots and crashes:

```bash
sudo cp tg-claude-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tg-claude-agent
```

Optional one-time setup scripts (see `scripts/`):
| Script | Enables |
|---|---|
| `preview-setup.sh` | `/preview` — Playwright/Chromium screenshots |
| `tunnel-setup.sh`  | `/tunnel` and Claude-driven public URLs (cloudflared) |
| `gh-setup.sh`      | `gh`/`git` commits & pushes as your GitHub account |
| `cleanup.sh`       | reclaim disk (apt/npm caches, old logs, orphaned temp files) |

Full environment variable reference is in `.env.example` (every var is
commented inline) and [ARCHITECTURE.md](./ARCHITECTURE.md).

## Commands

| Command | Does |
|---|---|
| `/new [emoji] <name>` | create a session, make it active |
| `/sessions` | list sessions (emoji, provider, model, last active) |
| `/switch <name>` | change the active session (fuzzy name match) |
| `/status` | active session: provider, model, context size, running? |
| `/compact` | Claude summarizes its own conversation — cuts cost, same session |
| `/renew [name]` | hard reset the conversation, keeps the session's files |
| `/kill <name>` | end a session (files kept — `/purge` to actually delete) |
| `/archived` / `/purge <name>` / `/disk` | disk-space housekeeping |
| `/model [name]` | show/set the model for this session |
| `/emoji [emoji\|all]` | set/backfill the session's tag emoji |
| `/preview [dev [port]]` | screenshot the site in the session's working dir |
| `/tunnel [dev [port]\|stop]` | managed public URL for one site |
| `/servers` | list/stop/tail background servers Claude started itself |
| `/cancel` | stop the task running in the active session |
| `/approve` / `/deny [id]` | respond to a pending action (`APPROVAL_GATE=1`) |
| `/reauth <token>` / `/setuptoken` / `/authcode <code>` | manage Claude subscription auth without a terminal |

Send a photo, PDF, or voice note and it's handled automatically — see
`/help` in the bot for the live, in-app version of this list.

## Security model

The bot runs with `bypassPermissions` by default (there's no TTY to answer
interactive prompts on a headless box) — a deny-list (`CLAUDE_DENY` in
`.env`) hard-blocks the obvious footguns regardless of mode: secret files,
`rm -rf`, force-push, editing the bot's own repo, `sudo`. Set
`APPROVAL_GATE=1` for a real per-action approval flow instead, or
`CLAUDE_PERMISSION_MODE` to tighten further.

This is accident/casual-misuse protection, **not** a hard sandbox — a
determined prompt injection with `bypassPermissions` can still work around
file-based blocks. Scope any cloud credentials (GitHub token, cloud provider
keys) you give it to the minimum it actually needs, and treat the bot as
running with your full local permissions, because it does.

## License

MIT — see [LICENSE](./LICENSE).
