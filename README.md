<h1 align="center">📱 tg-claude-code</h1>

<p align="center">
  <b>Run <a href="https://claude.com/claude-code">Claude Code</a> from Telegram.</b><br>
  Full agentic sessions - approval gate, live progress, GitHub, public tunnels,
  voice input - driven from your phone instead of a terminal.
</p>

<p align="center">
  <a href="https://github.com/16navigabraham/tg-claude-code/stargazers"><img src="https://img.shields.io/github/stars/16navigabraham/tg-claude-code?style=flat&logo=github&color=f5c518" alt="Stars"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-5FA04E?logo=node.js&logoColor=white" alt="Node >= 20">
  <img src="https://img.shields.io/badge/Claude%20Code-CLI-D97757?logo=anthropic&logoColor=white" alt="Claude Code">
</p>

<p align="center">
  ⭐ <b>If this is useful, star the repo</b> - it's the whole thank-you.
</p>

---

Originally built to drive Claude Code entirely from a VPS over a slow/metered
mobile connection, with no PC open. Multi-session, your Claude subscription as
the primary provider, a second Anthropic API key as a rate-limit
fallback, and every isolation rule needed so the two transcripts never mix.

## ✨ What it does

| | |
|---|---|
| 🗂️ **Multi-session** | `/new` `/switch` `/kill` - each session is its own working dir + isolated Claude Code state, so unrelated projects never bleed into each other's context. |
| 🔐 **Real approval gate** | `APPROVAL_GATE=1` → inline Approve / Deny buttons before every write / edit / shell command. The same prompt flow as an interactive terminal, over chat. |
| 💸 **Cost controls** | `/compact` (Claude summarizes itself), `/renew` (hard reset, keeps files), a `--max-turns` cap on unsupervised iterations, a deny-list for `rm -rf` / force-push / etc., and a context-size nudge before a session gets expensive. |
| 📡 **Live feedback** | A `⚙️ Working - <current step>` line that updates as the agent works, instead of silence until the final reply. |
| 🔁 **Fallback API key** | Set `FALLBACK_ANTHROPIC_API_KEY` and the bot auto-fails-over when your subscription is rate-limited - an isolated state dir so the two transcripts never mix ([why](./ARCHITECTURE.md#the-core-design-constraint--provider-isolation)). |
| 🐙 **GitHub-native** | Commits & pushes as your account via `gh`, no Claude co-author trailer. |
| 🌐 **Public tunnels** | `/tunnel` for one site, or let Claude run its own named background servers/tunnels (`scripts/daemon.sh`) for multi-project sessions - a public `*.trycloudflare.com` URL, nothing loads on your phone. |
| 🎙️ **Voice & files** | Voice notes → whisper.cpp → prompt. Photos & PDFs → handed to Claude. `/preview` → headless-Chromium screenshot. |
| 🔑 **Terminal-free auth** | `/reauth` and `/setuptoken` refresh the Claude subscription token from your phone - no SSH needed. |

## 🚀 Quick start

Needs a VPS (or any always-on Linux box) with **Node.js 20+**, the
[Claude Code CLI](https://claude.com/claude-code) installed & authenticated,
and a bot token from [@BotFather](https://t.me/BotFather).

```bash
git clone https://github.com/16navigabraham/tg-claude-code.git
cd tg-claude-code
npm install

cp .env.example .env
$EDITOR .env   # TELEGRAM_BOT_TOKEN + ALLOWED_TELEGRAM_USER_ID at minimum

node src/index.js
# In Telegram: /new test, then send a prompt - confirm you get a reply.
```

Run it as a service so it survives reboots & crashes:

```bash
sudo cp tg-claude-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tg-claude-agent
```

Optional one-time setup scripts (`scripts/`):

| Script | Enables |
|---|---|
| 📸 `preview-setup.sh` | `/preview` - Playwright / Chromium screenshots |
| 🌐 `tunnel-setup.sh` | `/tunnel` + Claude-driven public URLs (cloudflared) |
| 🐙 `gh-setup.sh` | `git` / `gh` commits & pushes as your GitHub account |
| 🧹 `cleanup.sh` | reclaim disk (apt/npm caches, old logs, orphaned temp files) |

Full env-var reference: [`.env.example`](./.env.example) (commented inline) and
[ARCHITECTURE.md](./ARCHITECTURE.md).

## 💬 Commands

| Command | Does |
|---|---|
| `/new [emoji] <name>` | create a session, make it active |
| `/sessions` | list sessions (emoji, provider, model, last active) |
| `/switch <name>` | change the active session (fuzzy name match) |
| `/status` | active session: provider, model, context size, running? |
| `/compact` | Claude summarizes its own conversation - cuts cost, same session |
| `/renew [name]` | hard-reset the conversation, keep the session's files |
| `/kill <name>` | end a session (files kept - `/purge` to delete) |
| `/archived` · `/purge <name>` · `/disk` | disk-space housekeeping |
| `/model [name]` | show / set the model for this session |
| `/emoji [emoji\|all]` | set / backfill the session's tag emoji |
| `/preview [dev [port]]` | screenshot the site in the session's working dir |
| `/tunnel [dev [port]\|stop]` | managed public URL for one site |
| `/servers` | list / stop / tail background servers Claude started |
| `/cancel` | stop the task running in the active session |
| `/approve` · `/deny [id]` | respond to a pending action (`APPROVAL_GATE=1`) |
| `/reauth <token>` · `/setuptoken` · `/authcode <code>` | manage Claude auth, no terminal |

Send a photo, PDF, or voice note directly - handled automatically. `/help` in
the bot is the live version of this list.

## 🛡️ Security model

Runs with `bypassPermissions` by default (a headless box has no TTY to answer
prompts) - a deny-list (`CLAUDE_DENY`) hard-blocks the footguns regardless of
mode: secret files, `rm -rf`, force-push, editing the bot's own repo, `sudo`.
Set `APPROVAL_GATE=1` for a real per-action approval flow, or
`CLAUDE_PERMISSION_MODE` to tighten further.

This is **accident / casual-misuse protection, not a hard sandbox** - a
determined prompt injection under `bypassPermissions` can still route around
file-based blocks. Scope every credential you give it (GitHub token, cloud
keys) to the minimum it needs, and treat the bot as running with your full
local permissions - because it does.

## 🤝 Contributing

Issues and PRs welcome. If you deploy it somewhere interesting or add a
command, open a PR to the command table.

## 📄 License

MIT - see [LICENSE](./LICENSE).

<p align="center"><sub>Built on <a href="https://claude.com/claude-code">Claude Code</a> · <a href="./ARCHITECTURE.md">Architecture notes</a></sub></p>
