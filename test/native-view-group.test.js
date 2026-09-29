import test from "node:test";
import assert from "node:assert/strict";
import { NativeViewGroup } from "../src/desktop/native-view-group.js";

const entry = () => {
  const view = { visible: false, closed: false, setVisible(value) { this.visible = value; }, setBounds(value) { this.bounds = value; } };
  view.webContents = { isDestroyed: () => view.closed, close: () => { view.closed = true; view.visible = false; } };
  return { view };
};
const group = () => new NativeViewGroup({ attach() {}, detach() {} });
test("leaving a page while its load is pending prevents late foreground display", () => {
  const views = group(), ticket = views.beginOpen(), page = entry();
  views.register("drive", page, ticket.generation);
  views.hide();
  assert.equal(views.show("drive", ticket), false);
  assert.equal(page.view.visible, false);
});
test("A to B to A displays only the newest intention, regardless of load completion order", () => {
  const views = group(), a = entry(), b = entry();
  views.register("a", a, 0); views.register("b", b, 0);
  const first = views.beginOpen(), second = views.beginOpen(), third = views.beginOpen();
  assert.equal(views.show("b", second), false);
  assert.equal(views.show("a", third, { x: 0, y: 0, width: 200, height: 100 }), true);
  assert.equal(views.show("a", first), false);
  assert.equal(a.view.visible, true); assert.equal(b.view.visible, false);
  assert.deepEqual(a.view.bounds, { x: 0, y: 0, width: 200, height: 100 });
});
test("account reset rejects late builders and old callbacks cannot destroy the new view", () => {
  const views = group(), old = entry(), fresh = entry(), generation = views.generation;
  views.reset();
  assert.equal(views.register("drive", old, generation), false);
  assert.equal(old.view.closed, true);
  views.register("drive", fresh, views.generation);
  assert.equal(views.remove("drive", old), false);
  assert.equal(fresh.view.closed, false);
  assert.equal(views.entries.get("drive"), fresh);
  views.reset();
  assert.equal(fresh.view.closed, true);
  assert.equal(views.entries.size, 0);
});
// Opened without its place (the 飞书原样 document view, and 设置's Feishu page,
// both place it only after the open returns), a view was shown at its warm-up
// size -- the whole window -- over every control in the app until the renderer
// caught up. Found by the UI rules while smoke-document-desktop.js ran
// (2026-09-25). A view is revealed only where it has been put.
test("a view is never revealed before it has been placed", () => {
  const views = group(), ticket = views.beginOpen(), page = entry();
  page.view.bounds = { x: 0, y: 0, width: 1250, height: 840 }; // its warm-up size
  views.register("document", page, ticket.generation);
  assert.equal(views.show("document", ticket), true, "the section is still the one open");
  assert.equal(views.visible, "document");
  assert.equal(page.view.visible, false, "but nothing is drawn until it has a place");
  assert.equal(views.place({ x: 560, y: 190, width: 690, height: 610 }), true);
  assert.equal(page.view.visible, true);
  assert.deepEqual(page.view.bounds, { x: 560, y: 190, width: 690, height: 610 });
  assert.equal(views.place({ x: 0, y: 0, width: 0, height: 0 }), false, "an empty place hides it again");
  assert.equal(page.view.visible, false);
  const again = views.beginOpen();
  assert.equal(views.show("document", again, { x: 0, y: 0, width: 0, height: 0 }), true);
  assert.equal(page.view.visible, false, "shown into an empty place is not shown");
});
