import test from "node:test";
import assert from "node:assert/strict";
import { clampPanelWidth, nativeSurfaceBounds, workbenchLayout } from "../src/desktop/renderer/task-workbench.js";

test("the task workbench chooses wide, medium and narrow layouts without squeezing both panes", () => {
  assert.deepEqual(workbenchLayout({ width: 1300, taskOpen: true, panelOpen: true, sidebarPreference: "auto" }), {
    viewport: "wide", sidebarVisible: true, sidebarOverlay: false, split: true, singlePane: false,
  });
  assert.deepEqual(workbenchLayout({ width: 1100, taskOpen: true, panelOpen: true, sidebarPreference: "auto" }), {
    viewport: "medium", sidebarVisible: false, sidebarOverlay: false, split: true, singlePane: false,
  });
  assert.deepEqual(workbenchLayout({ width: 1100, taskOpen: true, panelOpen: true, sidebarPreference: "open" }), {
    viewport: "medium", sidebarVisible: true, sidebarOverlay: false, split: false, singlePane: true,
  });
  assert.deepEqual(workbenchLayout({ width: 900, taskOpen: true, panelOpen: true, sidebarPreference: "auto" }), {
    viewport: "narrow", sidebarVisible: false, sidebarOverlay: false, split: false, singlePane: true,
  });
  assert.deepEqual(workbenchLayout({ width: 900, taskOpen: true, panelOpen: true, sidebarPreference: "open" }), {
    viewport: "narrow", sidebarVisible: true, sidebarOverlay: true, split: false, singlePane: true,
  });
});

test("a section showing a native page folds the sidebar away on a narrow window instead of laying it over the page", () => {
  // The Feishu sections: no task, no panel, the page itself a native layer that
  // an overlaid sidebar could only be shown over by hiding it.
  assert.deepEqual(workbenchLayout({ width: 900, taskOpen: false, panelOpen: false, nativeSurface: true, sidebarPreference: "auto" }), {
    viewport: "narrow", sidebarVisible: false, sidebarOverlay: false, split: false, singlePane: false,
  });
  // Asked for, it still opens over the page.
  assert.deepEqual(workbenchLayout({ width: 900, taskOpen: false, panelOpen: false, nativeSurface: true, sidebarPreference: "open" }), {
    viewport: "narrow", sidebarVisible: true, sidebarOverlay: true, split: false, singlePane: false,
  });
  // Wide enough for both, nothing changes.
  assert.equal(workbenchLayout({ width: 1100, taskOpen: false, panelOpen: false, nativeSurface: true, sidebarPreference: "auto" }).sidebarVisible, true);
  // A section of the app's own pages keeps the sidebar it had.
  assert.deepEqual(workbenchLayout({ width: 900, taskOpen: false, panelOpen: false, sidebarPreference: "auto" }), {
    viewport: "narrow", sidebarVisible: true, sidebarOverlay: true, split: false, singlePane: false,
  });
});

test("a panel resize preserves minimum usable widths for conversation and work", () => {
  assert.equal(clampPanelWidth({ requested: 900, available: 1100, conversationMin: 440, panelMin: 380 }), 654);
  assert.equal(clampPanelWidth({ requested: 120, available: 1100, conversationMin: 440, panelMin: 380 }), 380);
  assert.equal(clampPanelWidth({ requested: 520, available: 1100, conversationMin: 440, panelMin: 380 }), 520);
});

test("native surfaces receive zero bounds whenever their DOM panel is not actually visible", () => {
  const rect = { x: 480.4, y: 105.6, width: 619.8, height: 594.2 };
  assert.deepEqual(nativeSurfaceBounds(rect, true), { x: 480, y: 106, width: 620, height: 594 });
  assert.deepEqual(nativeSurfaceBounds(rect, false), { x: 0, y: 0, width: 0, height: 0 });
  assert.deepEqual(nativeSurfaceBounds(null, true), { x: 0, y: 0, width: 0, height: 0 });
});
