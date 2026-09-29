// Test-only entry for the 定时任务 smoke: the real application, unchanged, with
// its Agent bridge exposed so the smoke can run bin/agent.js the way a task's
// Agent does (see agent-harness.js). Everything behind the bridge -- the draft
// dialog, the confirmation cards, the control plane -- is production code.
import "../../src/adopt-legacy-env.js";
import { exposeBridge } from "./agent-harness.js";
await exposeBridge();
await import("../../src/desktop/main.js");
