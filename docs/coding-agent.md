# Coding agent: closing the harness gap with Codex

A coding task runs the pinned Codex (`codex app-server`, 0.155.0 since 2026-09-18; earlier measurements on this page were made on 0.147.0) in the folder the person chose, against the product gateway and whichever chat model the server enforces (GLM-5.3 through the local LiteLLM, or MiniMax-M3). The model is the same one Codex itself could be pointed at, so what a coding task can do comes down to the harness around it: the instructions, the tools and how their results come back. This page records what Codex actually sends for this product, what was missing, what changed, and how the result is measured.

## What Codex sends, measured

Measured with the real app-server against a stub Responses endpoint on loopback — a fresh `CODEX_HOME` per run, no model called:

- **Request shape.** `instructions` holds the catalog entry's base instructions. The first input item is a developer message of about 10,700 characters: Codex's own skills listing and permissions instructions, followed by the product's developer text. Next comes a user message with the root `AGENTS.md` and the environment context, then the person's text. Tools offered: `exec_command`, `write_stdin`, `update_plan`, `request_user_input`, `view_image` and the three goal tools. For GLM, `parallel_tool_calls` is false and reasoning effort is high.
- **Base instructions come with the catalog entry.** A `model_catalog_json` entry without `base_instructions` (or `model_messages.instructions_template`) stops the app-server at startup, and an empty string sends no instructions at all. For a model with no catalog entry, Codex sends its own built-in coding prompt (20,751 characters for GLM-5.3), but it then also lacks the entry's metadata: context window, output truncation, parallel tool calls and reasoning levels. The product needs that metadata, so it ships an entry, and until this change both entries carried a single product sentence.
- **`baseInstructions` on the protocol.** Given on `thread/start`, they replace the catalog's and are kept with the thread. Given on `thread/resume`, they replace the thread's for that turn. A resume without them uses the ones from start.
- **No patch tool for these models.** `apply_patch_tool_type` accepts only `freeform`, which is sent as a `custom` grammar tool that the gateway refuses and neither upstream takes; `"function"` fails catalog parsing. But when a command is exactly `apply_patch <<'EOF' … EOF`, Codex applies the patch itself — adds, updates, moves and deletes alike. It reports each as a `fileChange` item with its diff, emits `turn/diff/updated`, and routes it through file-change approval like any patch. If anything else shares the command, it runs in the shell as an ordinary command.
- `truncation_policy` accepts `mode: "tokens"`.

Before this change, 176 GLM rollouts ran on the one-sentence prompt. Across 256 task records there were 924 shell commands and no structured file change: files were written with `cat >`, heredocs, `sed -i` and `python3 -c`.

## What changed

1. **Instructions for coding.** `src/providers/codex/coding-agent-instructions.md` is the product's own base prompt. It covers how to work in a repository, `AGENTS.md` scope, keeping a plan with `update_plan`, running commands with `exec_command` and `write_stdin`, editing through `apply_patch`, checking work, reporting, and handling credentials. `src/modes.js` attaches it to the coding mode. `createTaskRuntime` and the terminal chat pass it as `baseInstructions` on start and on every resume, so a resumed task works from the current text. Work tasks keep the catalog's sentence.
2. **Edits through `apply_patch`.** The prompt gives the exact shape and says it must be the whole command. In the first evaluation run with the new prompt, GLM often put `npm test` after `EOF`. The shell answered `command not found: apply_patch`, and the Agent went looking for a patch program: it tried `git apply`, and once it searched npm and installed an unvetted patch package into `/tmp`. `bin/agent-shell/apply_patch` is now added to the end of the Agent's `PATH`. It applies nothing, reads and discards its input, and says to send the patch again on its own with other commands in a separate call. A standalone patch is still taken by Codex, measured with the program on the path. The prompt names both error messages.
3. **Tool output** is truncated at 10,000 tokens rather than 10,000 bytes, as for OpenAI's own entries. MiniMax-M3's entry also gains a context window, which GLM-5.3's already had, so Codex can compact a long task on it too. The window is 512,000 tokens, although MiniMax documents up to 1,000,000: a lower window only makes compaction come earlier, while one higher than a deployment really allows would fail before compaction starts.
4. **The folder prompt.** A work task still tells the model which files are in its folder and asks for clearly named outputs. A coding task no longer does: its folder is a repository the Agent reads with its own tools.
5. **Approvals.** Command and file-change cards add **本轮同类都允许** (`acceptForSession`). It covers only the rest of the turn, because each turn runs in its own Codex process. MCP calls are still confirmed one at a time. A command that asks to run outside the sandbox (`sandbox_permissions: "require_escalated"`) arrives as an ordinary command approval carrying the Agent's justification. Its request lists only accept, a persistent command rule and cancel, yet Codex honours decline and `acceptForSession` for it too (measured): decline fails that one command and the Agent carries on, where cancel would end the turn. The persistent rule is not offered.
6. **Questions.** TaskService turns `item/tool/requestUserInput` into a card instead of refusing it: up to five questions, labelled options, and free text where the question allows it. Nothing reaches the model until the person answers or skips. A question marked secret is answered empty at once, and a stopped task answers every open question empty. Out of the box the pinned Codex keeps that request to itself: outside Plan mode it answers `request_user_input` on its own (`request_user_input is unavailable in Default mode`). An earlier version of this note also said no request can select Plan mode; the experimental `turn/start` does take a `collaborationMode`, but Plan mode does not change files, so it is no mode for a coding task. What sends the question on is `features.default_mode_request_user_input`, set in `gateway-config.js`. Measured on the pinned 0.147.0 and on 0.154.0 against a scripted model: Codex then forwards `item/tool/requestUserInput` — every question marked `isOther`, `isBlocking: false`, no auto-resolution — and waits; with the answer held back 30 seconds, the model's next request still came only after it. The instructions now tell the Agent to ask through `request_user_input` instead of ending its turn. `scripts/smoke-coding-task-desktop.js` answers the card in the actual app and checks that nothing reaches the model until then and that the answer arrives as the tool's output. The terminal chat asks the same questions on its terminal, never asks for a secret, and with no terminal sends every question back unanswered.
7. **What the Agent did.**
   - The plan from `turn/plan/updated` is kept on the task and shown above the approvals, with completed steps struck through. A new message starts without one.
   - The execution record lists one row per step. A file change opens to show each file's diff, capped at 400 lines per file, named from the project's root. A command opens to show the last 2,000 characters of its output, where errors and test summaries are.
8. **Repositories above the folder.** A task opened on a package inside a monorepo, or on a worktree, commits to a `.git` that is not the folder's own. The writable roots now come from `git rev-parse --git-dir --git-common-dir`, falling back to the folder's own `.git` when it is not a repository yet.
9. **Subagents.** On. The Agent can hand a bounded subtask to a child agent with `spawn_agent` and collect the result with `wait_agent`; at most two children run at once, on the task's own model. Codex's own `<multi_agent_mode>` guidance, sent with every request, tells the model not to delegate unless the person, an `AGENTS.md` or a skill asks for it, so ordinary turns stay single-agent. Two gateway changes make it work: Codex's `collaboration` tools cross under their own names, and agents' `agent_message` items — which LiteLLM drops without a word — are handed on as user messages naming both agents. The conversation and the execution record show a child's words and steps as `子 agent · <name>`, and a child's approval cards belong to the parent task. The development status has the measurements.

## Evaluation

`node scripts/eval-coding-agent.js --live [--only …] [--label …]` runs coding tasks through the product's own path: TaskService, `createTaskRuntime`, the pinned Codex, and a local instance of the product gateway calling the server's configured chat model. Load the deployment environment first; the key never leaves the process.

The six tasks in `scripts/fixtures/coding-eval/`:

| Task | Kind |
|---|---|
| `t1-paginate` | bug fix, one file |
| `t2-stats-flags` | CLI feature across files, with new tests |
| `t3-rename` | rename across source, tests and README |
| `t4-duration` | implement from a written specification |
| `t5-queue` | debug an async bug |
| `t6-lru-cache` | implement a class with edge cases |

How each task runs:

- Every repository is copied fresh and committed, and the Agent gets only the request.
- It is judged by hidden tests copied in afterwards, plus a byte check on test files it was told to keep.
- Approvals are declined and counted.
- Each task records minutes, model requests, commands, structured file changes, shell edits (a heuristic), test runs, and install or download commands.

`test/coding-eval-fixtures.test.js` keeps the tasks honest without a model: every task must fail its hidden tests as shipped and pass them with its reference change.


## Against Codex and Claude Code: Terminal-Bench 2.1

Codex CLI and Claude Code are not run here. This harness works the same public tasks, and its result is set against their published leaderboard numbers. Terminal-Bench 2.1 is used because its leaderboard lists both as agents under one harness and one set of rules. It has 89 tasks, each in its own Docker image, under Apache-2.0, and a task passes when its tests pass.

`scripts/benchmarks/terminal_bench/`:

- **`gateway.js`** starts the product's model gateway for one run.
  - It listens on this Mac's loopback only; task containers in colima reach it at `192.168.5.2` (measured).
  - It keeps the chat model's key in its own process and gives containers a random token that works only while it runs.
  - It also writes the product's developer instructions for a coding task with full access, because the task container is the sandbox.
- **`idou_codex.py`** is a Harbor agent. It subclasses Harbor's own Codex agent, which installs a pinned Codex CLI in each task container and runs `codex exec` there, the way the leaderboard's Codex CLI runs were made. It changes only what the product changes:
  - Codex 0.147.0;
  - the product's catalog entry, carrying the coding instructions (`codex exec` takes no per-thread base instructions);
  - those developer instructions (the pinned Codex reads `developer_instructions` from its config, measured);
  - the `apply_patch` fallback;
  - the gateway.

```
set -a; . <deployment file>; set +a
node scripts/benchmarks/terminal_bench/gateway.js --run-dir <run> --port 43210 &
PYTHONPATH=. IDOU_BENCHMARK_RUN_DIR=<run> OPENAI_API_KEY="$(cat <run>/token)" \
  harbor run -p <terminal-bench-2-1>/tasks -i <task> \
    -a scripts.benchmarks.terminal_bench.idou_codex:IdouCodex -m GLM-5.3 -k 1 -n 1 \
    -o ~/Library/Caches/idou-terminal-bench/jobs
```

With colima, Harbor's jobs directory (`-o`) must be under the home directory. colima shares only the home directory with its VM. A trial directory anywhere else is mounted into the task container as an empty directory the Mac never sees, so the verifier's reward file and the agent's logs are lost; Harbor then reports every trial as `RewardFileNotFoundError` (measured).

What a result from this Mac can and cannot say:

- **Not a leaderboard score.** The leaderboard score is the mean of at least five trials over all 89 tasks. A pilot of a few tasks, one trial each, checks that the harness works and gives an indication; it is not comparable to that score.
- **Slower hardware, same timeouts.** This Mac is Apple Silicon. 85 of the 89 task images are amd64-only, and they run under QEMU emulation in a 4-CPU, 6 GiB VM, against the same timeouts that cloud runs had. Several tasks need 8 GB of memory and cannot run here as configured.
- **Self-reported.** Leaderboard submissions for 2.1 are closed, so a result here cannot be verified there; trajectories are kept for inspection.
- **Reference rows.** These are a research digest of the tbench.ai and Snorkel leaderboard pages; check them on tbench.ai before citing:
  - Codex CLI + GPT-5.5: 83.1%;
  - Claude Code + Opus 4.8: 78.9%;
  - Claude Code + Fable 5: 83.8%;
  - GLM-5.1 + Claude Code: 58.7%, the nearest same-family row.

### Pilot result on this Mac (2026-09-14)

Ten tasks, one trial each (fix-git as a smoke, then a nine-task pilot). This is a plumbing check and an indication, not a leaderboard score.

- **The harness was clean wherever it ran.** Every model request was 200 — 91 in the first pass, 40 in the re-run, 21 in the smoke; no 429, 504 or 502.
- **The first pass showed the local ceiling: three of nine never reached the gateway.** They failed in Harbor's own Codex-agent bootstrap under QEMU — `apt-get install nodejs npm` returning a dpkg error (regex-log), or the six-minute Codex-install timeout (sqlite-with-gcov, git-leak-recovery) — before any product code ran.
- **Fixed by uploading a prebuilt Codex binary.** The Codex native binary is a static-pie musl executable that needs neither Node nor apt, so `idou_codex.py` now uploads it to `/usr/local/bin/codex` and skips the per-container install (falling back to it only when the binary is not cached on the host). Extract it once from a container that has it:
  ```
  docker cp <image>:/…/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex \
    ~/Library/Caches/idou-terminal-bench/codex-linux-x64
  ```
  Re-running the three failures, agent setup fell from ~6 minutes (or a dpkg failure) to **1 second**, and all three reached the gateway and passed.
- **With the bootstrap fixed, eight of ten are solved.** Solved: polyglot-c-py (7 apply_patch changes), log-summary-date-ranges, openssl-selfsigned-cert, cancel-async-tasks, password-recovery, regex-log, sqlite-with-gcov, git-leak-recovery. The two misses are model-side: fix-git (the agent over-recovered, merging unreachable commits beyond the reflog change the task described) and kv-store-grpc (a hard gRPC task it did not complete).
- **Reading it.** Through this harness GLM-5.3 solved 8 of 10 at one trial each; the failures that were the harness's to own did not happen. This is an indication, not a leaderboard number — that is the mean of at least five trials over all 89 tasks — and several of the heaviest 89 still need more memory than a 6 GiB colima gives.

## 标准 has no network for commands

Since 0.1.0-20260929.258, 标准 (the default) runs commands without network, as Codex's own default does: a document or a message the Agent reads can carry someone else's instructions, and with the network open a command could send this machine's files anywhere without a card (security review of 2026-09-27). A command that needs the network -- installing a dependency, pushing to a remote -- is run asking for escalation, which reaches the person as a command approval card. 自动 keeps the network; the person picks it to run unattended.

The application's own two tools still reach it: the bundled Feishu CLI talks to its sidecar, and `bin/agent.js` to the desktop's bridge, both on loopback, which the sandbox shuts with everything else. Each gets a Codex rule that runs it outside the sandbox without asking (`src/providers/codex/tool-rules.js`), written into the task's Codex home before Codex starts. What the pinned Codex matches, measured and asked of the binary again in `test/codex-tool-rules.test.js`:

- only an absolute path, unquoted, at the start of a command of its own. A quoted path, a pipe, a redirection or an assignment keeps the whole command in the sandbox, and the Agent is told so;
- never a name: a rule for a name runs whatever that name finds first on PATH, impostor included;
- the agent tool runs through a launcher the application writes (`~/.idou/agent-tools/<copy>/idou-agent`), which names the runtime and the script by their paths.

This rests on no sandboxed command being able to write those tools, what they run, or the rules; a working folder that could is refused for a sandboxed task. And a project's own `.codex` folder -- rules, settings, hooks -- is loaded by Codex for any project nobody marked (a repository's rule allowing `curl` let it out of the sandbox), so a project that has one is marked untrusted, which skips it along with its AGENTS.md; a project without one keeps its AGENTS.md.

## Still open

- **Permission requests.** `item/permissions/requestApproval` (extra filesystem or network access) is still refused. A command asking to leave the sandbox does not use it: it arrives as a command approval, which is handled. No tool offered to these models was seen to raise it.
- **Plan mode.** Unused on purpose: the experimental `turn/start` can select it, but Plan mode does not change files. The Agent's questions no longer depend on it (see Questions above). `features.default_mode_request_user_input` is still marked under development upstream, so a Codex upgrade has to run `scripts/smoke-coding-task-desktop.js` again.
- **Gateway limits.** The gateway allows 90 requests a minute per session and 8 at once overall, and neither Codex nor the gateway retries. The limits were 30 and 4 until a session could hold a task's agent and two subagents; the evaluation never reached the old ones.
- **Shell environment.** Only a short allowlist reaches the shell: no proxy variables, no SSH agent. In a packaged app the PATH is the person's login-shell PATH, read once when the app starts; Codex puts its own rg in front of it, and the product's `apply_patch` and `node` fallbacks come last.
- **Codex's own web search stays off.** The agent searches through the web-fetch connector's `web_search` instead. Subagents used to be listed here as left off, for a measured reason — the gateway refused Codex's `collaboration` namespace and reported it as `unsupported_tool_type` — and are now on (item 9 above).
- **Computer/GUI control is not something Codex can hand us.** `computer_use` and `browser_use` are real flags — `codex doctor` lists both as enabled by default — but turning them on changes nothing a turn actually sends. Measured on the pinned 0.147.0 and again on 0.154.0 (bundled inside ChatGPT.app, so no download was needed) with `scripts/smoke-codex-tools.js`: identical tool lists with the flags on and off, with a valid and accepted computer-use configuration, under `read-only` and `danger-full-access` alike, and with `code_mode` on (which does add `exec`/`wait` of type `custom` — itself refused by the gateway — but no computer-use tools). The binary carries no computer-use tool schema, no action verbs and no display geometry; the names appear only in the feature enum and in an enterprise policy struct where an administrator permits or forbids them; and `ClientCapabilities` has no fields, so no handshake unlocks anything. 0.154.0 does add a per-application access schema (`computer_use.default_app_access` = `allow`/`deny`, `computer_use.macos.bundle_ids`), which is configuration for a capability the model provider supplies — and MiniMax and GLM do not. Unlike subagents, the gateway is not the obstacle here; the capability simply is not local.
- **Work tasks** still run on the catalog's one-sentence base instructions.
