// Synthetic review-only bundle. Never published or installed by production code.
import { readFileSync } from "node:fs";

// Declared compatible with the Codex this checkout pins, read from the lock: a
// version written here went stale with the 0.155 upgrade, the skill turned
// preview-only exactly as the product intends for a skill nobody re-declared,
// and every smoke using it failed on a greyed-out button.
const PINNED_CODEX = JSON.parse(readFileSync(new URL("../../upstreams.lock.json", import.meta.url), "utf8")).codex.version;

export function skillFixture() {
  return { id: "enterprise-project-brief", version: "1.0.0", title: "项目进展整理（合成测试）", description: "整理已有信息并标注待确认事项，仅用于签名目录与预览验收。", publisher: "测试企业 · 工作方法组",
    requiredTools: ["cli:local-files"], runtimeVersions: { codex: [PINNED_CODEX], feishu: [] },
    files: [{ path: "SKILL.md", text: "---\nname: enterprise-project-brief\ndescription: Synthetic catalog fixture, not a deployed skill.\n---\n# 项目进展整理\n\n只根据用户提供的资料整理事实；缺少证据的事项标为待确认。\n\n<script>window.__skillExecuted = true;</script>" },
      { path: "references/checklist.md", text: "此文件是合成测试资源。检查来源、进展、风险和下一步。" }] };
}
