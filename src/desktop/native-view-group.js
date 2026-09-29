// Owns cached native views independently of their asynchronous page loads.
// A hide supersedes pending opens; an account reset also invalidates builders.
// Background warm-up may populate the cache, but never wins foreground focus.
export class NativeViewGroup {
  constructor({ attach, detach }) {
    this.attach = attach; this.detach = detach;
    this.entries = new Map(); this.visible = null;
    this.generation = 0; this.intent = 0;
  }
  beginOpen() { return { generation: this.generation, intent: ++this.intent }; }
  current(ticket) { return ticket?.generation === this.generation && ticket.intent === this.intent; }
  register(kind, entry, generation) {
    if (generation !== this.generation) { this.#close(entry); return false; }
    const old = this.entries.get(kind);
    if (old && old !== entry) this.remove(kind, old);
    entry.view.setVisible(false);
    this.entries.set(kind, entry);
    this.attach(entry.view);
    return true;
  }
  // The section becomes this one; the view itself is drawn only once it has a
  // place (below). Shown without one, it used to appear at its warm-up size --
  // the whole window -- over every control in the app until the renderer sent
  // where it goes (2026-09-25, the 飞书原样 document view and 设置's Feishu page).
  show(kind, ticket, bounds) {
    if (!this.current(ticket)) return false;
    const entry = this.entries.get(kind);
    if (!entry || entry.view.webContents.isDestroyed()) return false;
    for (const [name, other] of this.entries) if (name !== kind) other.view.setVisible(false);
    this.visible = kind;
    this.place(bounds);
    return true;
  }
  // Where the shown view goes. An empty or missing place keeps it hidden.
  place(bounds) {
    const entry = this.visible ? this.entries.get(this.visible) : null;
    if (!entry || entry.view.webContents.isDestroyed()) return false;
    const drawn = Boolean(bounds) && bounds.width > 0 && bounds.height > 0;
    if (bounds) entry.view.setBounds(bounds);
    entry.view.setVisible(drawn);
    return drawn;
  }
  hide() {
    this.intent++; this.visible = null;
    for (const entry of this.entries.values()) entry.view.setVisible(false);
  }
  remove(kind, entry) {
    if (this.entries.get(kind) !== entry) return false;
    this.entries.delete(kind);
    if (this.visible === kind) this.visible = null;
    this.#close(entry);
    return true;
  }
  reset() {
    this.generation++;
    this.hide();
    for (const [kind, entry] of this.entries) this.remove(kind, entry);
  }
  #close(entry) {
    try { this.detach(entry.view); } catch { /* already detached */ }
    const contents = entry.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
  }
}
