// Confirmation cards represent a person's decision.  Automated desktop runs
// may inspect a card, leave it waiting, or take an explicitly negative action;
// they must never manufacture a positive answer.

const NEGATIVE_AUTOMATED_CHOICES = new Set(["取消", "拒绝"]);

// These smokes contain a positive confirmation path.  The acceptance runner
// runs them only as far as their first card that needs a person's yes
// (IDOU_SMOKE_UNTIL_CARD, fixtures/agent-harness.js) and reports them
// separately; with --with-person a person answers and they run to the end.
// The manual id is the name of the manual acceptance check each one stands for.
export const MANUAL_CONFIRMATION_SMOKES = new Map(Object.entries({
  "smoke-agent-delete-desktop.js": ["M03"],
  "smoke-agent-feishu-desktop.js": ["M04"],
  "smoke-base-desktop.js": ["M04"],
  "smoke-app-review-desktop.js": ["M09"],
  "smoke-apps-desktop.js": ["M09"],
  "smoke-chat-reply-desktop.js": ["M05"],
  "smoke-cli-bridge-write-desktop.js": ["M04"],
  "smoke-coding-approvals-desktop.js": ["M01"],
  "smoke-coding-task-desktop.js": ["M02", "M07"],
  "smoke-computer-agent-live.js": ["M01"],
  "smoke-discovery-desktop.js": ["M10"],
  "smoke-document-delivery-desktop.js": ["M05"],
  "smoke-document-edit-desktop.js": ["M04"],
  "smoke-document-group-delivery-desktop.js": ["M05"],
  "smoke-login-desktop.js": ["M08"],
  "smoke-mcp-desktop.js": ["M08"],
  "smoke-mcp-live.js": ["M01"],
  "smoke-mcp-remote-live.js": ["M01"],
  "smoke-media-desktop.js": ["M06"],
  "smoke-preview-agent-live.js": ["M01"],
  "smoke-preview-desktop.js": ["M01", "M03"],
  "smoke-question-agent-live.js": ["M07"],
  "smoke-runtime-desktop.js": ["M09"],
  "smoke-schedules-desktop.js": ["M03", "M10"],
  "smoke-sites-desktop.js": ["M09"],
  "smoke-skill-mcp-desktop.js": ["M08"],
  "smoke-web-identity-desktop.js": ["M10"],
  "smoke-web-search-live.js": ["M01"],
}));

export function assertAutomatedConfirmationChoice(label) {
  if (!NEGATIVE_AUTOMATED_CHOICES.has(label)) {
    throw new Error(`自动化不能替用户选择“${label}”；请停在卡片上并记录对应人工验收项`);
  }
}

export function manualConfirmationIds(name) {
  return MANUAL_CONFIRMATION_SMOKES.get(name) ?? null;
}
