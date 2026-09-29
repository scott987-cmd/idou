const DIVIDER_WIDTH = 6;

// `nativeSurface`: the section's content is a native page (Feishu's), which an
// overlaid sidebar can only be drawn over by hiding the page. So such a section
// folds the sidebar away on a narrow window, as an open task does, instead of
// laying it over a page that then goes blank; asked for, it still overlays.
export function workbenchLayout({ width, taskOpen, panelOpen, nativeSurface = false, sidebarPreference = "auto" }) {
  const viewport = width >= 1200 ? "wide" : width >= 960 ? "medium" : "narrow";
  const autoHide = (taskOpen || nativeSurface) && (viewport === "narrow" || (viewport === "medium" && panelOpen));
  const sidebarVisible = sidebarPreference === "open" || (sidebarPreference === "auto" && !autoHide);
  const sidebarOverlay = viewport === "narrow" && sidebarVisible;
  const split = panelOpen && (viewport === "wide" || (viewport === "medium" && !sidebarVisible));
  return { viewport, sidebarVisible, sidebarOverlay, split, singlePane: panelOpen && !split };
}

export function clampPanelWidth({ requested, available, conversationMin, panelMin }) {
  const maximum = Math.max(panelMin, Math.floor(available - conversationMin - DIVIDER_WIDTH));
  return Math.max(panelMin, Math.min(maximum, Math.round(requested)));
}

export function nativeSurfaceBounds(rect, visible) {
  if (!visible || !rect) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) };
}
