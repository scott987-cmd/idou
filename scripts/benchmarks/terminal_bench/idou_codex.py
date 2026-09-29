"""The product's coding harness as a Terminal-Bench agent for Harbor.

Harbor's own Codex agent installs a pinned Codex CLI inside each task container
and runs `codex exec` there, which is how the leaderboard's Codex CLI runs were
made. This subclass keeps all of that and changes only what the product changes:

- Codex 0.147.0, the version the product pins;
- the product's model catalog entry, carrying the product's coding instructions
  (`codex exec` takes no per-thread base instructions, so they travel in the
  entry, which is where Codex reads them from anyway);
- the product's developer instructions for a coding task with full access, when
  the gateway wrote them (the task container is the sandbox, as for the
  leaderboard agents);
- the apply_patch fallback on PATH;
- the model through the product gateway on this Mac
  (scripts/benchmarks/terminal_bench/gateway.js), which task containers reach
  at 192.168.5.2.

    PYTHONPATH=<repository> OPENAI_API_KEY="$(cat <run dir>/token)" \\
    IDOU_BENCHMARK_RUN_DIR=<run dir> harbor run -p <terminal-bench-2-1>/tasks \\
      -a scripts.benchmarks.terminal_bench.idou_codex:IdouCodex -m GLM-5.3 ...
"""

import json
import os
import tempfile
from pathlib import Path

from harbor.agents.installed.codex import Codex

ROOT = Path(__file__).resolve().parents[3]
CATALOG = ROOT / "src" / "providers" / "codex" / "model-catalog.json"
INSTRUCTIONS = ROOT / "src" / "providers" / "codex" / "coding-agent-instructions.md"
FALLBACK = ROOT / "bin" / "agent-shell" / "apply_patch"
REMOTE_CATALOG = "/tmp/codex-home/idou-model-catalog.json"
MODEL = "GLM-5.3"
CODEX_VERSION = "0.147.0"
# A prebuilt, statically linked linux Codex binary, uploaded straight into each
# task container. Harbor's own Codex agent installs Node + @openai/codex per
# container (apt nodejs/npm, then nvm + npm -g), which under QEMU emulation either
# fails on dpkg or blows the six-minute setup timeout — that is what kept most
# pilot tasks from ever reaching the gateway. The native binary needs no Node, no
# apt and no npm, so uploading it sidesteps the whole bootstrap. Extract it once
# (musl static-pie, runs on any linux/amd64 image) from a container that has it:
#   docker cp <image>:/…/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex \
#     ~/Library/Caches/idou-terminal-bench/codex-linux-x64
CODEX_LINUX_BIN = Path(
    os.environ.get("IDOU_CODEX_LINUX_BIN")
    or (Path.home() / "Library" / "Caches" / "idou-terminal-bench" / "codex-linux-x64")
)


def _run_dir() -> Path | None:
    value = os.environ.get("IDOU_BENCHMARK_RUN_DIR")
    return Path(value) if value else None


def _gateway_url() -> str:
    run_dir = _run_dir()
    if run_dir and (run_dir / "gateway.json").is_file():
        return json.loads((run_dir / "gateway.json").read_text())["containerBaseUrl"]
    return "http://192.168.5.2:43210/v1"


def _gateway_provider(name: str) -> dict:
    return {
        "name": name,
        "base_url": _gateway_url(),
        "wire_api": "responses",
        "env_key": "OPENAI_API_KEY",
        # A transient LiteLLM/colima hiccup should retry rather than fail a whole
        # task. The product ships 0 here on purpose (single dispatch through the
        # gateway); this cushion is benchmark-only, so a blip is not read as a
        # coding failure.
        "request_max_retries": 2,
        "stream_max_retries": 2,
    }


class CodexNative(Codex):
    """Codex CLI as it comes, on the same model through the same gateway.

    The control for a same-model comparison: Codex 0.147.0 with no catalog
    entry, so it sends its own built-in coding prompt (measured for GLM-5.3),
    and none of the product's instructions or the apply_patch fallback. Only the
    route to the model is set, with reasoning effort matched and web search off,
    since the gateway refuses web search tools.
    """

    def __init__(self, *args, **kwargs):
        kwargs.setdefault("version", CODEX_VERSION)
        kwargs.setdefault("config", {
            "model_provider": "idou",
            "model_reasoning_effort": "high",
            "web_search": "disabled",
            "model_providers": {"idou": _gateway_provider("Model gateway (Terminal-Bench, Codex as it comes)")},
        })
        super().__init__(*args, **kwargs)


class IdouCodex(Codex):
    def __init__(self, *args, **kwargs):
        config = {
            "model_provider": "idou",
            "model_reasoning_effort": "high",
            "web_search": "disabled",
            "model_catalog_json": REMOTE_CATALOG,
            "model_providers": {
                "idou": {
                    "name": "idou gateway (Terminal-Bench)",
                    "base_url": _gateway_url(),
                    "wire_api": "responses",
                    "env_key": "OPENAI_API_KEY",
                    # Benchmark-only cushion for transient LiteLLM/colima blips;
                    # the product ships 0 (single dispatch) on purpose.
                    "request_max_retries": 2,
                    "stream_max_retries": 2,
                }
            },
            "features": {"collab": False, "multi_agent": False},
            "analytics": {"enabled": False},
            "feedback": {"enabled": False},
        }
        run_dir = _run_dir()
        if run_dir and (run_dir / "developer-instructions.txt").is_file():
            config["developer_instructions"] = (run_dir / "developer-instructions.txt").read_text()
        kwargs.setdefault("version", CODEX_VERSION)
        kwargs.setdefault("config", config)
        super().__init__(*args, **kwargs)

    async def _install_codex(self, environment) -> None:
        # Upload the prebuilt static binary instead of installing Node + Codex per
        # container. Fall back to the base install (apt + nvm + npm) only if the
        # binary is not cached on the host, so the adapter still works everywhere.
        if await self._installed_codex_satisfies_version(environment):
            return
        if CODEX_LINUX_BIN.is_file():
            await environment.upload_file(CODEX_LINUX_BIN, "/usr/local/bin/codex")
            await self.exec_as_root(environment, command="chmod 755 /usr/local/bin/codex")
            if await self._installed_codex_satisfies_version(environment):
                return
            self.logger.warning(
                "Uploaded Codex binary did not report the pinned version; falling back to per-container install"
            )
        else:
            self.logger.warning(
                "No cached Codex binary at %s; falling back to per-container install", CODEX_LINUX_BIN
            )
        await super().install(environment)

    async def install(self, environment) -> None:
        await self._install_codex(environment)
        catalog = json.loads(CATALOG.read_text())
        entry = next(model for model in catalog["models"] if model["slug"] == MODEL)
        entry = {**entry, "base_instructions": INSTRUCTIONS.read_text()}
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory) / "catalog.json"
            local.write_text(json.dumps({"models": [entry]}))
            await self.exec_as_agent(environment, command="mkdir -p /tmp/codex-home")
            await self._upload_agent_owned_file(environment, local, REMOTE_CATALOG)
        await environment.upload_file(FALLBACK, "/usr/local/bin/apply_patch")
        await self.exec_as_root(environment, command="chmod 755 /usr/local/bin/apply_patch")
