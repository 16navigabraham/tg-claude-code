# Architecture

Technical design notes: why the code is shaped the way it is, what's verified
against a real Claude Code CLI, and the full environment-variable reference.
Read this before changing `src/providerRouter.js` or `src/persistentClaude.js`
— the provider-isolation rule below is the one thing not to "simplify" back.

## The core design constraint — provider isolation

The subscription and the fallback API key each accumulate their own Claude
Code transcript. Resuming one credential's conversation under the other is a
correctness hazard: the real API validates the *entire* accumulated
transcript on resume, so if the fallback is ever pointed at a proxy whose
request/response shapes aren't byte-identical, a single fallback-produced
turn resumed under the real API returns **HTTP 400** for the whole request.
Keeping the two credentials on fully separate `--resume` chains sidesteps it
regardless of what the fallback endpoint is.

How it's prevented (all in `src/providerRouter.js`):

1. **Two state dirs per session**, chosen per spawn via `CLAUDE_CONFIG_DIR`:
   `claude-state` (subscription only), `fallback-state` (fallback API key
   only). Never shared.
2. Each provider only ever `--resume`s its **own** `*_cli_session_id`. Never
   crossed.
3. **Fallback branches, never resumes**: the first turn on a fresh provider is
   seeded with plain conversation *text* pulled from the bot's own SQLite
   `messages` table (`buildSeedPrefix`), never the other provider's raw
   Claude Code transcript. The same seeding happens on the first subscription
   turn after a fallback period (recovery), keyed off `*_cli_session_id`
   being `null`.
4. Recovery always spawns against `claude-state`; a fallback-produced turn never reaches the subscription’s transcript.
5. The fallback env vars (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
   `ANTHROPIC_MODEL`) are injected into the fallback subprocess's env only —
   the subscription spawn's env has zero Anthropic vars and relies purely on
   the OAuth credentials file.

**Do not consolidate to one shared session directory per project** — that
reintroduces exactly this bug.

## How a prompt flows through the code (`src/`)

- **`index.js`** — env check, `createBot()`, `bot.launch()`, then
  `notifyInterrupted` (DMs each chat about any task killed by the previous
  shutdown). `unhandledRejection` is logged; `uncaughtException` is logged and
  the process exits so the service manager restarts it clean.
- **`bot.js`** — Telegraf. Auth middleware restricts to `ALLOWED_TELEGRAM_USER_ID`.
  Command and `text`/`photo`/`document`/`voice` handlers all funnel into
  `deliver()`, which: shows a queue-busy notice if the session is already
  running something; posts one "⚙️ Working" status message it edits
  (~12s throttle) via an `onProgress` callback; writes an `inflight` row for
  restart-recovery bookkeeping; runs `routePrompt` through a per-session
  promise chain (`runQueued` — messages to one session are serialized,
  different sessions run in parallel); chunks the reply to Telegram's 4096-char
  limit; deletes the status message. `friendlyError()` maps error classes
  (cancelled / interrupted / stalled / max-runtime / not-logged-in /
  rate-limited / fallback-failed / unconfigured-fallback) to plain-language replies.
- **`providerRouter.js`** — `routePrompt(session, prompt, {onProgress})`:
  subscription first (unless `FORCE_FALLBACK=1`), fallback API key on a
  detected rate limit. `runClaudeSubprocess` spawns
  `claude -p --output-format stream-json --verbose --permission-mode <mode>
  [--model X] [--max-turns N] [--strict-mcp-config] [--resume <id>]` with the
  prompt written to stdin (not passed as an arg — see *Verified CLI facts*
  below). A stall timer kills the run after `CLAUDE_STALL_TIMEOUT_MS` of no
  output; an absolute `CLAUDE_MAX_RUNTIME_MS` backstop applies regardless of
  activity. `activeRuns` + `cancelRun(sessionId)` power `/cancel`.
- **`persistentClaude.js`** — optional (`PERSISTENT_CLAUDE=1`) alternative to
  spawn-per-message: keeps one long-lived `claude -p --input-format
  stream-json --output-format stream-json` process per session, writing each
  turn as a JSON line to its stdin and reading the `result` event back. This
  keeps Anthropic's prompt cache warm across turns (spawn-per-message
  re-pays the full system-prompt + tool-definition cost every message,
  which is the single biggest reason bot usage can outrun an interactive
  terminal session). Idle-killed after `PERSISTENT_IDLE_MS` and respawned
  with `--resume` on the next message.
- **`sessionManager.js`** — session CRUD. `resolveSession` matches by exact
  name → case-insensitive exact → unique case-insensitive prefix, so
  `/switch`/`/kill` are forgiving of casing and partial names.
- **`db.js`** — SQLite schema + idempotent `ALTER TABLE` migrations + query
  helpers.
- **`preview.js`** — `/preview`: static mode serves the directory containing
  `index.html` (searched up to 3 levels deep) on `PREVIEW_PORT`; `dev` mode
  runs `npm run dev` and polls common ports until one responds. Either way,
  Playwright/Chromium screenshots the result full-page at 1280×800.
- **`tunnel.js`** — `/tunnel`: reuses `preview.js`'s server logic, then runs
  `cloudflared tunnel --url` and parses the `*.trycloudflare.com` URL from its
  stderr. One managed tunnel per session; auto-closes on idle/max-lifetime/kill.
- **`scripts/daemon.sh`** — a small process manager (`start|stop|list|logs|
  stop-under`) that Claude itself is told about via
  `--append-system-prompt` (see `SESSION_SYSTEM_NOTE` in `providerRouter.js`).
  It re-parents processes with `setsid` (falls back to `nohup`) so a server or
  tunnel *Claude* starts survives the `claude -p` process exiting when it
  replies — needed for sessions juggling multiple projects, where the
  single-tunnel `/tunnel` command doesn't fit. `/servers` in Telegram
  lists/stops/tails what's running.
- **`transcribe.js`** — voice notes: downloads the Telegram voice file,
  normalizes to 16kHz mono WAV with `ffmpeg`, transcribes with a local
  `whisper.cpp` build, filters out common hallucination placeholders
  (`[BLANK_AUDIO]`, "(speaks in foreign language)", etc.).
- **`approvals.js` / `approvalServer.js`** — the real approval gate
  (`APPROVAL_GATE=1`). Each spawn runs with `--permission-mode default` and
  `--permission-prompt-tool` pointing at a tiny stdio MCP server
  (`approvalServer.js`, one instance per run) that forwards each permission
  request over a Unix socket to the long-lived bot process (`approvals.js`),
  which posts a Telegram message with inline Approve/Deny buttons and blocks
  until a decision (15-minute auto-deny). This is the same interactive-prompt
  experience as running Claude Code in a terminal, delivered over chat.
- **`rateLimitReminder.js`** — when a subscription rate-limit is detected,
  schedules a one-off DM for the moment it resets. Reset time comes from the
  structured `rate_limit_event`'s epoch-seconds field when present; otherwise
  it's best-effort regex-parsed from Claude's own free-text "resets 2:20pm"
  wording (assumes that clock time is already in the process's `TZ`).

## Verified CLI facts

These were confirmed by running a real prompt against a live Claude Code CLI
(2.1.x) — re-verify if you hit unexpected behavior on a different version:

- `claude -p ... --output-format stream-json` **requires `--verbose`**, or
  the CLI errors.
- The prompt must go on **stdin**, not as a positional CLI argument — `-p` is
  just the `--print` boolean flag, so a prompt beginning with `-` (a voice
  transcript starting "- yeah…", for instance) gets parsed as an unknown
  option if passed as an arg.
- stream-json events include: `system/init` (carries `session_id`),
  `assistant` (`message.content[].{text|tool_use}`, `message.usage`), `result`
  (`{subtype, result, is_error, api_error_status}`), `rate_limit_event`
  (`rate_limit_info.status` — anything off `"allowed"`/`"allowed_warning"`
  means throttled).
- A failed run can exit **0** while carrying `"is_error":true` on the
  `result` event — never trust exit code alone.
- Exit code 143/137/`null` on a run usually means the bot process itself was
  restarted mid-run (SIGTERM/SIGKILL from the service manager), not a real
  Claude-side failure.
- `CLAUDE_CONFIG_DIR` overrides the entire state tree location — but nothing
  auto-populates OAuth credentials into a fresh directory, so the credentials
  file must be explicitly linked/copied in or every run reports "Not logged in".
- `/compact` forwarded as a literal prompt works even under `-p` and keeps the
  same `--resume` chain (Claude summarizes its own conversation) — confirmed
  present in the CLI's own `slash_commands` list.
- A `/compact`-only run produces no `assistant` text blocks — just a `system`
  event carrying `compact_metadata.{pre_tokens,post_tokens}`. Code that
  assumes every run has assistant text will misbehave on this one (this repo
  had that bug; see git history for the fix).

## Environment variables

Every variable is documented inline in `.env.example`; this is the
narrative version grouped by concern.

**Required:** `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_ID`.

**Paths:** `SESSIONS_ROOT`, `DB_PATH`.

**Model & cost:**
- `CLAUDE_MODEL` — default model for new sessions (blank = plan default);
  per-session `/model` overrides it.
- `CLAUDE_STRICT_MCP=1` — drops the user's configured MCP connectors from bot
  runs. Usually the single biggest token saving (~15-20k tokens/message with
  several connectors configured).
- `CLAUDE_MAX_TURNS` (default 30) — caps agentic tool-loop iterations per
  message via `--max-turns`. Unsupervised, one instruction can otherwise run
  20-40 iterations, each re-billing the whole context — the biggest usage gap
  versus a human-steered terminal session, where a person stops it. On hit,
  the reply ends with a prompt to reply "continue". `0` disables the cap
  (also the fallback if `--max-turns` isn't a valid flag on your installed
  CLI version).
- `PERSISTENT_CLAUDE=1` / `PERSISTENT_IDLE_MS` — see *persistentClaude.js*
  above.
- `CONTEXT_WARN_TOKENS` (default 160000) — above this, replies append a
  `/compact` nudge and `/status` flags the session as heavy. Claude Code
  auto-compacts on its own regardless; this just surfaces the size so you can
  pre-empt it with `/compact` before it happens automatically mid-task.

**Timeouts:**
- `CLAUDE_STALL_TIMEOUT_MS` (default 300000 = 5 min of no output → killed)
- `CLAUDE_MAX_RUNTIME_MS` (default 2700000 = 45 min absolute backstop)

**Permissions / safety:**
- `CLAUDE_PERMISSION_MODE` (default `bypassPermissions` — on a headless box
  with no TTY, anything stricter denies or hangs every command; use
  `APPROVAL_GATE` below for a real prompt flow instead).
- `CLAUDE_DENY` — newline/comma-separated deny rules, enforced even under
  `bypassPermissions`. If unset, sensible defaults apply: secret files
  (`~/.aws`, `~/.ssh`, `~/.config/gh`, `~/.claude`, `.env`, `data/`), edits to
  the bot's own repo, `rm -rf`, `git push --force`, `git reset --hard`,
  `gh repo delete`, `gh secret`, `sudo`. This is accident/casual-misuse
  protection, not a hard sandbox boundary — a determined prompt injection
  under `bypassPermissions` can still work around file-based blocks via other
  tools (e.g. reading a denied file through a scripting language instead of
  the Read tool).
- `APPROVAL_GATE=1` — real per-action Telegram approval (see
  `approvals.js`/`approvalServer.js` above). `APPROVAL_FALLBACK` (allow|deny)
  decides what happens if the bot is unreachable when a prompt fires.

**Fallback provider:** `FALLBACK_ANTHROPIC_API_KEY` (an Anthropic API key
from console.anthropic.com — set this to enable the fallback),
`FALLBACK_ANTHROPIC_MODEL` (default `claude-sonnet-4-5`),
`FALLBACK_ANTHROPIC_BASE_URL` (defaults to `https://api.anthropic.com`; only
set it for an API-compatible proxy), `FORCE_FALLBACK=1` (always use the
fallback, for testing). `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` is set
on the fallback spawn.

**Misc:** `TZ` (passed into every spawn so Claude's own timestamped messages,
like rate-limit reset times, aren't UTC-only), `PREVIEW_PORT`/
`PREVIEW_WAIT_MS`, `TUNNEL_IDLE_MS`/`TUNNEL_MAX_MS`/`TUNNEL_WAIT_MS`/
`CLOUDFLARED_BIN`, `WHISPER_BIN`/`WHISPER_MODEL`/`WHISPER_THREADS`,
`DAEMON_DIR`.

## Deploying and redeploying

Typical redeploy after a code change:
```bash
git pull && sudo systemctl restart tg-claude-agent
```
**Don't restart while a task is running** — `/cancel` first or wait for the
reply. After any restart the bot DMs the affected chat about interrupted
tasks (via the `inflight` table).

**If the bot's own repo is deployed with a read-only deploy key** (recommended
— see `scripts/gh-setup.sh` for setting up a separate, broader-scoped GitHub
identity for the bot's *other* work): a `bypassPermissions` session must not
be able to push to the repo that auto-deploys onto the very box running it.
Work on the bot's own code from a trusted machine, or have a session clone the
repo into its own working directory and only show you a diff — never edit the
live deployed copy in place.

The systemd unit ships with `KillMode=process` so that detached servers/tunnels
started via `scripts/daemon.sh` survive a bot restart or redeploy.
