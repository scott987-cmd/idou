// 选中修改 in a site's preview window (docs/sites-phase1.md §1.2): the page's
// own element picker, driven from this process through the Chrome DevTools
// Protocol -- the same inspect mode DevTools uses.
//
// Why not a script in the page: anything put into the page is reachable by the
// page's scripts, which could then "pick" whatever they liked, or answer for
// the element they were asked about. Here the outline is drawn by the browser,
// the click is taken by the browser, and the element is described in an
// isolated world the page's scripts cannot see. Nothing is added to the page
// and nothing of this reaches its files.
import { DESCRIBE_PICKED } from "../application/site-pick.js";

const HIGHLIGHT = Object.freeze({
  showInfo: false, showStyles: false, showRulers: false, showExtensionLines: false,
  contentColor: { r: 224, g: 122, b: 36, a: 0.16 }, paddingColor: { r: 224, g: 122, b: 36, a: 0.08 },
  borderColor: { r: 224, g: 122, b: 36, a: 0.95 }, marginColor: { r: 0, g: 0, b: 0, a: 0 },
});

export class SitePicker {
  #contents; #onPicked; #onError; #attached = false; #picking = false; #listener = null; #picked = null;
  // `contents`: the preview's page. `onPicked(description, backendNodeId)` once
  // the person clicks an element; `onError(error)` when that fails.
  constructor(contents, { onPicked, onError }) {
    this.#contents = contents; this.#onPicked = onPicked; this.#onError = onError;
  }

  get picking() { return this.#picking; }

  async #send(method, params = {}) { return this.#contents.debugger.sendCommand(method, params); }

  async #attach() {
    if (this.#attached) return;
    const tool = this.#contents.debugger;
    if (!tool.isAttached()) tool.attach("1.3");
    this.#attached = true;
    this.#listener = (_event, method, params) => {
      if (method === "Overlay.inspectNodeRequested" && this.#picking) void this.#describe(params.backendNodeId).catch((error) => this.#onError(error));
    };
    tool.on("message", this.#listener);
    tool.once("detach", () => { this.#attached = false; this.#picking = false; });
    await this.#send("DOM.enable");
    await this.#send("Overlay.enable");
  }

  // Waiting for a click: every element under the pointer outlined.
  async start() {
    await this.#attach();
    this.#picking = true;
    await this.#send("Overlay.setInspectMode", { mode: "searchForNode", highlightConfig: HIGHLIGHT });
  }

  // After a reload the page is a new document: picking again if it was.
  async resume() {
    if (!this.#attached) return;
    await this.#send("DOM.enable").catch(() => {});
    await this.#send("Overlay.enable").catch(() => {});
    if (this.#picking) await this.#send("Overlay.setInspectMode", { mode: "searchForNode", highlightConfig: HIGHLIGHT }).catch(() => {});
    else if (this.#picked) await this.#send("Overlay.highlightNode", { highlightConfig: HIGHLIGHT, backendNodeId: this.#picked }).catch(() => {});
  }

  async #describe(backendNodeId) {
    this.#picking = false;
    await this.#send("Overlay.setInspectMode", { mode: "none", highlightConfig: HIGHLIGHT });
    // Kept outlined while the person says what to change it to.
    await this.#send("Overlay.highlightNode", { highlightConfig: HIGHLIGHT, backendNodeId }).catch(() => {});
    this.#picked = backendNodeId;
    const { frameTree } = await this.#send("Page.getFrameTree");
    const { executionContextId } = await this.#send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "idou-site-pick", grantUniveralAccess: false });
    const { object } = await this.#send("DOM.resolveNode", { backendNodeId, executionContextId });
    try {
      const { result, exceptionDetails } = await this.#send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: DESCRIBE_PICKED, returnByValue: true });
      if (exceptionDetails || !result?.value) throw new Error("没能读出选中的这一处");
      this.#onPicked(result.value, backendNodeId);
    } finally {
      await this.#send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    }
  }

  // Back to looking: nothing outlined, nothing waiting for a click, and the
  // protocol let go of so the page runs as it would anywhere else.
  async stop() {
    this.#picking = false; this.#picked = null;
    if (!this.#attached) return;
    await this.#send("Overlay.setInspectMode", { mode: "none", highlightConfig: HIGHLIGHT }).catch(() => {});
    await this.#send("Overlay.hideHighlight").catch(() => {});
    const tool = this.#contents.debugger;
    if (this.#listener) tool.removeListener("message", this.#listener);
    this.#listener = null;
    this.#attached = false;
    try { if (tool.isAttached()) tool.detach(); } catch { /* the page is going away */ }
  }
}
