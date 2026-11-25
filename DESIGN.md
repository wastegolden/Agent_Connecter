# Agent_Connecter — Architecture & Implementation Spec

> Standalone cross-machine Plan Relay & Report system for Windows LAN (`Upper Machine -> Always-On Lower Machine`), independent of `agent-bridge` (which remains strictly local single-machine multi-harness collaboration).

## 0. Engineering Style Constraint (MANDATORY)
- **Keep code clean, direct, and lean.** No overly defensive boilerplate, no speculative abstraction layers, no redundant double-wrapping of checks Node already handles, no unused hooks or dead config knobs.
- **Zero external runtime npm dependencies.** Pure **Node.js 24+ ESM** (`"type": "module"`) using built-ins (`node:http`, `node:sqlite`, `node:crypto`, `node:fs`, `node:zlib`, `node:child_process`, `node:path`, `node:stream/promises`).
- Enforce the **real** invariants cleanly in one place each; keep memory lean for a memory-constrained Windows headless host (idle server RSS target ≤ 60 MiB with small SQLite `PRAGMA cache_size`, streaming gzip upload/decompress peak ≤ 150 MiB).

---

## 1. Roles & Unified Plugin Model

Both Upper Machine (主力机, shuts down) and Lower Machine (常开桌面登录态 Windows 无头主机) install the **exact same unified plugin package** (`agent-connecter`), supporting **Codex**, **Claude Code**, and **Antigravity** (DSH is intentionally excluded from cross-machine layer).

Only the local config (`~/.agent-connecter/config.json`) and small local companion process differ:
- **Lower Machine (`mode: "server"`)**:
  - Runs `bin/connecter-server.mjs` (single lightweight Node 24 process hosting LAN HTTP + Loopback HTTP + SQLite WAL + SSE + Launcher + static web dashboard).
  - Mounts the included Antigravity Plugin Sidecar (`sidecars/antigravity-bridge/`) inside Antigravity Desktop App so Antigravity App conversations can be created, resumed, and woken natively via official `agentapi`.
  - MCP server (`bin/connecter-mcp.mjs`) connects to `127.0.0.1:<localPort>`.
- **Upper Machine (`mode: "client"`)**:
  - MCP server (`bin/connecter-mcp.mjs`) connects outbound to `http://<lower-ip>:<lanPort>` with Bearer token; runs local lossless Context Packer.
  - Optional tiny `bin/connecter-notifier.mjs` subscribes to SSE and pops Windows WinRT Toast notifications.
- `mode: "both"` allowed for dev/testing only.

---

## 2. Network, Pairing Auth & Auto-Update

### 2.1 Dual-Listener Isolation (Same Process)
- **LAN Listener** (`0.0.0.0:3090` default, Private + `LocalSubnet` firewall rule): serves `/health`, `/api/pair`, `/api/capabilities`, `/api/jobs*`, `/api/events` (SSE), `/api/update/*`, and `/` (static dashboard).
- **Loopback Listener** (`127.0.0.1:3091` default): serves internal worker/sidecar endpoints ONLY (`/local/jobs/:id/register`, `/local/jobs/:id/reports`, `/local/jobs/:id/wait-decision`, `/local/jobs/:id/ack-decision`, `/local/sidecar/heartbeat`, `/local/sidecar/events`). Physically unreachable from LAN.

### 2.2 Pure LAN HTTP + One-Time Pairing Verification (TOFU)
- Lower machine generates a single-use pairing code (`connecter-cli pair`, 5-min TTL, 5-attempt lockout).
- Upper machine runs `connecter-cli link http://<host>:3090 --code <CODE>` (calling `POST /api/pair`):
  - Server consumes & invalidates the code immediately, issues a per-client 256-bit Bearer token (stored hashed in SQLite, raw token saved in client credentials file), and returns permanent `serverMachineId` (UUID v4).
  - Client pins `serverMachineId` and sends `Authorization: Bearer <token>` on every call (`crypto.timingSafeEqual`).
  - Tokens can be revoked per client (`connecter-cli revoke <clientName>`).
- Internal worker reports use a per-job capability token scoped to `(jobId, runId)` (minted on launch and passed via job dir metadata file, not CLI args).

### 2.3 Web Dashboard (`GET /`, single static HTML file, zero build step)
- Public login gate: user pastes Bearer token into JS memory variable (never in URL query string).
- All API calls and SSE stream use `fetch()` + `ReadableStream` with `Authorization: Bearer <token>` (since browser `EventSource` cannot send custom headers).
- Render reports with `textContent` / `<pre>` (no `innerHTML` XSS risk). Supports inspecting jobs, viewing `plan_proposal` / final `report`, and clicking `approve` / `revise` / `cancel`.

### 2.4 Version Handshake & Safe Auto-Update
- Server exposes `protocolVersion` (int) and `pluginVersion` (semver) in `/api/capabilities` and response headers; major mismatch fails closed.
- Server optionally serves a SHA-256 verified update manifest & gzip bundle (`/api/update/manifest`, `/api/update/bundle`) built from its deployed package.
- `connecter-cli update` checks version diff, downloads + verifies SHA-256, atomically swaps `%LOCALAPPDATA%\agent-connecter\current` (with rollback on error), and refreshes plugin manifests when changed (taking effect cleanly on next session without killing live MCP servers).

---

## 3. Core Workflow, Mandatory Controller & State Machine

### 3.1 Fail-Closed Explicit Controller Selection
- **MANDATORY**: `targetHarness` (`"codex" | "claude-code" | "antigravity"`) and `targetProject` (must match Lower Machine's configured project whitelist) are **required with NO defaults** on both client and server (`TARGET_HARNESS_REQUIRED`, `TARGET_HARNESS_UNAVAILABLE`, `TARGET_PROJECT_UNKNOWN`).
- Never auto-select a fallback harness and never silently switch harnesses on failure. Optional `targetModel` / `reasoningEffort` may be passed explicitly.

### 3.2 Concurrency Policy
- **No global concurrency limit** (multiple projects/jobs can run in parallel; `agent-bridge` manages its own inner concurrency).
- **Single anti-collision guard**: reject launching/enqueuing a second active job targeting the **exact same `targetSessionId`** (`SESSION_BUSY`).

### 3.3 Two-Phase State Machine (Default `approvalMode: "plan_first"`)
States in SQLite (`jobs.status`, SQLite is the single source of truth; on-disk Markdown files are materialized views):
`queued -> launching -> planning -> awaiting_approval -> approved -> executing -> needs_input -> completed | failed | cancelled` (plus `needs_resume` if an approval/reply arrives while a live non-injectable session cannot be injected).

1. **Dispatch**: Upper machine runs `connecter_pack_preview` (produces frozen gzip bundle + `bundleHash` + stats) then `connecter_dispatch` (uploads that exact frozen bundle via streaming HTTP with `Idempotency-Key`, 24h dedupe window).
2. **Launch & Register**: Server verifies whitelist, `targetHarness`, compressed limit (32 MiB) and streaming uncompressed limit (128 MiB), materializes `<dataDir>/jobs/<jobId>/{manifest.json, PLAN.md, PROMPT.md, CONTEXT/}`, and launches visible session. Worker calls `connecter_job_context` (registering `runId`, `harnessSessionId`, real CLI PID) to confirm startup (`planning`).
3. **Phase 1 — Plan Proposal (`plan_first` default)**:
   - Worker reads `PLAN.md` + `CONTEXT/`, inspects local repo, and submits `connecter_submit_report { kind: "plan_proposal", ... }` with local code check + module breakdown + multi-harness/DSH task allocation.
   - Server assigns immutable `proposalId` + `version`, moves job to `awaiting_approval`, emits SSE event (persisted cursor, last 500 events / 24h).
   - Worker waits cleanly without burning LLM tokens: short bounded wait (`connecter_wait_decision`, ≤55s), OR background shell task `connecter-cli wait-decision --job <id>` (zero LLM tokens), OR clean exit with resume on approval.
4. **Phase 2 — Decision**:
   - Upper machine (MCP `connecter_respond` / CLI / Web dashboard) submits `approve | revise | cancel` bound to `proposalId` (or `questionId` for `needs_input`; stale ID returns `DECISION_STALE`).
   - Decision persists in SQLite + `decisions/decision-<seq>.md`. Waiting `wait-decision` wakes immediately; if session exited or is Antigravity App / Codex, server triggers wakeup (`agentapi send-message` / `codex queue --resume` / `wt.exe --resume` if exited). Worker acknowledges decision (`approved -> executing`).
5. **Phase 3 — Execute & Report**:
   - Worker executes using local repo & local `agent-bridge`, may send `progress` or `needs_input` (`questionId`), and finishes with `completed` or `failed` report (conclusion, changed files, git branch, commit hash, test evidence).

---

## 4. High-Purity Lossless Context Packer (`src/packer/`)

Deterministic noise stripping — **zero lossy AI summarization**, preserving 100% of user turns, assistant replies, and full memory/artifact originals while stripping protocol noise.

### 4.1 Safe SQLite WAL Reading
- **Never copy `.db/.db-wal/.db-shm` sequentially on a live DB.**
- If `<db>-wal` exists: open source briefly and call Node 24's built-in `sqlite.backup()` to create a consistent temp snapshot before querying.
- If `<db>-wal` does not exist: copy single `.db` file to a temp dir before opening so the original directory is never touched (avoids Node 24 `readOnly:true` leaving `-wal/-shm` sidecars behind).

### 4.2 Verified Harness Extractors
1. **Codex** (`src/packer/codex.mjs`):
   - Index: `~/.codex/sqlite/codex.db` using `SELECT c.* FROM local_thread_catalog c JOIN local_thread_catalog_hosts h USING (host_id) WHERE h.host_kind = 'local'` (fallback `~/.codex/session_index.jsonl`). Never include `remote-control` / `chatgpt` metadata-only rows as local transcripts.
   - Memories: check both `~/.codex/sqlite/memories_1.sqlite` and `~/.codex/memories_1.sqlite` (`stage1_outputs`, deduplicated by `thread_id` keeping latest `source_updated_at`) + `~/.codex/memories/*`.
   - Transcript: `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` and `archived_sessions/`. Keep `session_meta`, all `response_item` messages where `payload.role` is `"user"` or `"assistant"` (`input_text`, `output_text`, plus `[image omitted]` markers for `input_image`), and concise tool call summaries; strip `developer`/`system`, `world_state`, `compaction`, `token_count`, `thread_settings_applied`.
2. **Claude Code** (`src/packer/claude.mjs`):
   - Index & transcripts: `~/.claude/projects/<encoded-cwd>/*.jsonl` (authoritative `cwd` from JSONL) + `memory/*.md` + optional `~/.claude/history.jsonl`.
   - Keep `user` & `assistant` text + `tool_use` summaries (track `isSidechain` / `uuid` / `parentUuid`, skip `progress`, `queue-operation`, `file-history-snapshot`, `last-prompt`, `relocated`, and default-skip `thinking` unless `includeThinking: true`); fold oversized `tool_result` (>4 KiB) keeping head/tail + error traces and optionally attaching full redacted text under `CONTEXT/attachments/`.
3. **Antigravity App & CLI** (`src/packer/antigravity.mjs`):
   - Scan BOTH `~/.gemini/antigravity/` (`origin: "app"`) and `~/.gemini/antigravity-cli/` (`origin: "cli"`), using `conversation_summaries.db` (`conversation_summaries` + `conversations_fts`).
   - Read `brain/<id>/.system_generated/logs/transcript.jsonl`; whenever `truncated_fields` is present on `USER_INPUT`, `PLANNER_RESPONSE`, or `GENERIC` entries, resolve the full record from `transcript_full.jsonl` by `step_index` (never assume matching line index!).
   - Auto-include `brain/<id>/*.md` artifacts.
4. **Redaction & Manifest** (`src/packer/redact.mjs`):
   - Mask accidental secrets (`sk-...`, Bearer tokens, PEM private keys, common API key patterns) and report exact `redactedCount` (total replacements) + per-source raw/clean bytes & SHA-256 in `manifest.json`. Never read `auth.json` / `.credentials.json` / `.sandbox-secrets`.

---

## 5. Visible Session Launcher & Antigravity App Sidecar (`src/launcher/`)

### 5.1 Launch & Resume Matrix
| Harness | New Visible Session | Resume / Wake Existing Session |
| :--- | :--- | :--- |
| **`antigravity`** (App, default) | Via Antigravity Plugin Sidecar (`bin/antigravity-sidecar.mjs` connected to loopback SSE): `agentapi new-conversation -- "<pointer>"` (or `ConversationService/CreateConversation` when dynamic `projectId` is present). Visible directly in Antigravity Desktop App UI. | Via Antigravity Plugin Sidecar: `agentapi send-message <conversationId> "<pointer>"` — continues the exact existing Antigravity Desktop App conversation in-place! |
| **`antigravity`** (explicit CLI mode `antigravityMode: "cli"`) | `wt.exe -w 0 new-tab --title "[connecter] <title>" -d <cwd> -- <agy.exe> --prompt-interactive "<pointer>"` | `wt.exe -w 0 new-tab --title "[connecter] <title>" -d <cwd> -- <agy.exe> --conversation <id> --prompt-interactive "<pointer>"` |
| **`codex`** | `wt.exe -w 0 new-tab --title "[connecter] <title>" -d <cwd> -- <codex.exe> -C <cwd> "<pointer>"` | Primary: `codex.exe queue --thread <id> --message "<pointer>" --resume` (confirmed by worker heartbeat, never trust exit code 0 alone); fallback: `wt.exe ... -- <codex.exe> resume <id> "<pointer>" -C <cwd>` |
| **`claude-code`** | `wt.exe -w 0 new-tab --title "[connecter] <title>" -d <cwd> -- <claude.exe> "<pointer>"` | `wt.exe -w 0 new-tab --title "[connecter] <title>" -d <cwd> -- <claude.exe> --resume <id> "<pointer>"` |

- If `targetHarness === "antigravity"` (App default) and the Antigravity Sidecar is not connected, fail closed with `TARGET_HARNESS_UNAVAILABLE` — **never silently downgrade to CLI**.

### 5.2 Essential Launcher Safety Invariants
1. **File-pointer only**: Materialize `PROMPT.md` (with random-boundary untrusted-data fence), `PLAN.md`, and `CONTEXT/` under server-generated `<dataDir>/jobs/<jobId>/`. Pass ONLY a short pointer string validated to contain no `;` or control chars to `wt.exe` / CLI / `agentapi`.
2. **`shell: false` + argv arrays** everywhere; validate `targetProject` against configured whitelist.
3. **Env scrubbing**: Strip caller session vars matching `agent-bridge 2.1.1`'s pattern (`CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_CODE_*`, `CODEX_THREAD_ID`, `CODEX_TURN_ID`, `CODEX_CALL_ID`, `CODEX_APP_TOOLS_*`, `ANTIGRAVITY_*`, `AGY_REQUIRE_AUTHENTICATED_UI_BOOTSTRAP`, `AGENT_BRIDGE_*`, `DSH_MCP_TOKEN`, `DSH_BRIDGE_*`).
4. **Non-elevated runtime**: Setup script may run elevated once to add the `LocalSubnet` firewall rule, but the scheduled task for `connecter-server` MUST run as the normal interactive logged-in user (never persistently elevated).

---

## 6. MCP Tools & Project Layout

### 6.1 Unified MCP Server (`bin/connecter-mcp.mjs`)
- **Client tools** (`mode: "client" | "both"`): `connecter_targets`, `connecter_local_sessions`, `connecter_pack_preview`, `connecter_dispatch` (`targetHarness` & `targetProject` strictly required), `connecter_jobs`, `connecter_get_report`, `connecter_respond`.
- **Server tools** (`mode: "server" | "both"`, loopback only): `connecter_job_context` (also registers session/PID), `connecter_submit_report`, `connecter_wait_decision` (bounded ≤55s), `connecter_ack_decision`.

### 6.2 Directory Layout
```text
Agent_Connecter/
  package.json                     # Pure Node 24 ESM, zero runtime deps
  DESIGN.md
  .claude-plugin/plugin.json
  .codex-plugin/plugin.json
  .codex-mcp.json
  .antigravity-plugin/plugin.json
  .antigravity-mcp.json
  sidecars/antigravity-bridge/sidecar.json
  skills/agent-connecter/SKILL.md
  bin/
    connecter-server.mjs           # Lower machine server (LAN + Loopback + SQLite + SSE + Launcher)
    connecter-mcp.mjs              # Unified MCP stdio server
    connecter-cli.mjs              # CLI (pair / link / revoke / pack / dispatch / approve / report / wait-decision / update)
    connecter-notifier.mjs         # Optional upper machine SSE -> Windows WinRT Toast
    antigravity-sidecar.mjs        # Antigravity App Plugin Sidecar bridging loopback SSE -> agentapi
  src/
    config.mjs
    auth.mjs
    store.mjs
    packer/ (index.mjs, codex.mjs, claude.mjs, antigravity.mjs, redact.mjs)
    launcher/ (index.mjs, env.mjs, wt.mjs, codex.mjs, claude.mjs, antigravity.mjs)
    server/ (http.mjs, dashboard.html, updater.mjs)
    client/ (http.mjs, toast.mjs, updater.mjs)
    mcp/ (server.mjs)
  scripts/
    setup-server.mjs
    setup-client.mjs
    validate-plugins.mjs
  test/                            # node --test suite
```
