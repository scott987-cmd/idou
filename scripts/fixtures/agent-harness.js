// Driving a real Agent operation from an acceptance script.
//
// The capabilities that used to be panels are Agent operations now, so the
// scripts that proved them have to reach the same code the Agent reaches. They
// do it the way the Agent does: run `bin/agent.js` as a real child process with
// the environment the application hands a task. Everything after that is
// production code -- the loopback bridge, the action, the confirmation, the
// provider -- with only the upstream stubbed, exactly as before.
//
// A model is deliberately not involved. Whether Codex decides to call the tool
// is covered by scripts/smoke-agent-feishu-desktop.js; what these scripts prove
// is what happens once it does.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertAutomatedConfirmationChoice } from "./confirmation-policy.js";

const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "agent.js");

// Called from a fixture entry, before main.js is imported. Keeps a reference to
// the one bridge the application starts so a script can ask it for the same
// environment a task's Agent would get.
export async function exposeBridge() {
  const { AgentBridge } = await import("../../src/application/agent-bridge.js");
  const started = AgentBridge.prototype.start;
  AgentBridge.prototype.start = async function (...args) {
    const value = await started.apply(this, args);
    globalThis.agentHarness = { ...(globalThis.agentHarness ?? {}), bridge: this };
    return value;
  };
}

// Runs one Agent operation. Returns immediately with a promise, because an
// operation that writes blocks on the in-app confirmation the script still has
// to answer.
export function runAgentTool(app, taskId, args, { cwd = process.cwd() } = {}) {
  // Electron's evaluate hands the electron module first and the argument second.
  const started = app.evaluate((_electron, id) => {
    if (!globalThis.agentHarness?.bridge) throw new Error("agent bridge not started");
    return globalThis.agentHarness.bridge.environment(id);
  }, taskId);
  return started.then(environment => new Promise((resolve) => {
    const child = spawn(process.execPath, [tool, ...args], { cwd, env: { ...process.env, ...environment } });
    let stdout = "", stderr = "";
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    child.on("close", code => resolve({ code, stdout, stderr, json: parse(stdout) }));
  }));
}

function parse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

// Answers the in-app confirmation the operation is waiting on. The button is
// matched by its label so a script says which decision it is making.
// A card's text as it reads with its folded 核对信息 open -- without opening it
// on the screen of a person who may be looking at it.
// How the acceptance run goes through a smoke only a person can finish
// (IDOU_SMOKE_UNTIL_CARD=1, set by run-desktop-acceptance.js): it drives
// the smoke up to the first card that needs a person's yes, lets the UI rules
// look at that card (a screenshot is their checkpoint), and stops there. It
// never answers. The smoke's own finally blocks still run -- stopping by exit
// would leave its control plane and scratch directories behind -- and the
// runner reports the smoke as having reached its card, not as passed.
export const UNTIL_CARD = process.env.IDOU_SMOKE_UNTIL_CARD === "1";
export const REACHED_CARD = "[到卡片为止]";
export class ReachedCard extends Error {
  constructor(what) { super(`${REACHED_CARD} ${what}：自动运行不替人确认，停在这里`); this.name = "ReachedCard"; }
}
// Once stopped at a card, what the smoke still had in flight -- a reply
// waiting for an answer, an observer on the page -- fails as the app closes.
// Those are the stop's own consequences, not the smoke's result: the marker is
// out first, and the stragglers are noted rather than allowed to crash the
// process before the stop reaches the top.
let stragglersNoted = false;
async function reachCard(page, what) {
  process.stdout.write(`${REACHED_CARD} ${what}\n`);
  if (!stragglersNoted) {
    stragglersNoted = true;
    process.on("unhandledRejection", (reason) => { process.stderr.write(`（停在卡片之后，没做完的操作随应用关闭而中止：${String(reason?.message ?? reason).split("\n")[0].slice(0, 160)}）\n`); });
  }
  try { await page.screenshot({ path: path.join(os.tmpdir(), `idou-reached-card-${process.pid}.png`), scale: "css" }); } catch { /* the stop stands either way */ }
  throw new ReachedCard(what);
}
// For a smoke's own wait for a person (not one of the helpers below): stop here
// when the acceptance run is going only as far as the first card.
export async function untilCard(page, what) { if (UNTIL_CARD) await reachCard(page, what); }
// Bring the window to the person -- or, run by the acceptance suite, stop.
export async function bringToPerson(page, what) { await untilCard(page, what); await page.bringToFront(); }

export const cardText = (node) => [node.innerText, ...[...node.querySelectorAll("details.confirm-technical pre")].map((pre) => pre.textContent)].join("\n");

export async function answerConfirm(page, label, { timeout = 30_000 } = {}) {
  assertAutomatedConfirmationChoice(label);
  const card = page.locator("#confirmations .confirm-card");
  await card.waitFor({ timeout });
  const text = await card.evaluate(cardText);
  await card.getByRole("button", { name: label }).click();
  return text;
}

// Wait for the exact pending choice, not merely for any card. A settled card
// remains visible for a few seconds after cancellation; treating that shell as
// the next request lets an acceptance scenario mutate its fixture before the
// real request has even reached confirmation.
export async function waitForConfirmationChoice(page, { detailText, label, timeout = 30_000 }) {
  const button = page.locator("#confirmations .confirm-card")
    .filter({ hasText: detailText })
    .getByRole("button", { name: label, exact: true });
  await button.waitFor({ state: "visible", timeout });
  return button;
}

// Manual acceptance scripts use this instead of clicking a positive action.
// It prints what is waiting and observes the exact button disappear after the
// person acts in the real application window.  It never dispatches the click.
export async function waitForHumanChoice(card, label, { timeout = 1_800_000 } = {}) {
  await card.waitFor({ timeout });
  const button = card.getByRole("button", { name: label, exact: true });
  await button.waitFor({ timeout });
  await untilCard(card.page(), label);
  const text = await card.evaluate(cardText);
  process.stdout.write(`待人工操作：请在应用中核对卡片并亲手点击“${label}”\n`);
  await button.waitFor({ state: "detached", timeout });
  return text;
}

// Arm this before a card can appear when the person may act immediately. It
// observes one exact card and resolves after that card's choice disappears; it
// never dispatches a click or otherwise answers the confirmation.
export function observeHumanChoice(page, { detailText, label, timeout = 1_800_000 }) {
  const token = randomUUID();
  const pending = (async () => {
    // Install synchronously in the renderer and return at once. Keeping the
    // evaluate call pending until the person clicked used to block other page
    // evaluations (notably layout checks and title changes) on reply flows.
    await page.evaluate(({ detailText, label, timeout, token, untilCard }) => {
      const choices = globalThis.__idouHumanChoices ??= Object.create(null);
      const state = choices[token] = { done: false, error: null, id: null, text: "", labels: [], primary: 0, focused: "", layout: null };
      const host = document.querySelector("#confirmations");
      const finish = (error = null) => {
        if (state.done) return;
        state.done = true; state.error = error;
        clearTimeout(timer); observer.disconnect(); resizer.disconnect();
        document.documentElement.setAttribute("data-idou-human-choice", token);
      };
      const capture = () => {
        const node = host?.querySelector(`.confirm-card[data-confirm-id="${state.id}"]`);
        if (!node) return;
        const sidebar = document.querySelector(".sidebar")?.getBoundingClientRect();
        const buttons = [...node.querySelectorAll(".confirm-actions button")], boxes = buttons.map(button => button.getBoundingClientRect());
        const card = node.getBoundingClientRect();
        state.labels = buttons.map(button => button.textContent);
        state.primary = node.querySelectorAll("button.primary").length;
        state.focused = document.activeElement?.textContent ?? "";
        state.layout = { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          width: innerWidth, height: innerHeight,
          cardInside: Boolean(sidebar) && card.left >= sidebar.right - 1 && card.right <= innerWidth,
          buttonsReachable: Boolean(sidebar) && boxes.every(box => box.width > 0 && box.left >= sidebar.right - 1 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight) };
      };
      const inspect = () => {
        const node = host?.querySelector(".confirm-card"), detail = node?.querySelector("pre")?.textContent ?? "";
        const button = [...(node?.querySelectorAll(".confirm-actions button") ?? [])].find(item => item.textContent === label);
        if (!state.id && detail.includes(detailText) && button) {
          if (untilCard) { state.id = node.dataset.confirmId; finish("__reached_card__"); return; }
          state.id = node.dataset.confirmId;
          state.text = [node.innerText, ...[...node.querySelectorAll("details.confirm-technical pre")].map((pre) => pre.textContent)].join("\n");
          capture();
        }
        // A click removes the action buttons a frame before the renderer drops
        // the card. Resolve only when this exact card is gone, otherwise the
        // next duplicate/no-card assertion can observe the retiring shell.
        if (state.id && !host?.querySelector(`.confirm-card[data-confirm-id="${state.id}"]`)) finish();
      };
      const observer = new MutationObserver(inspect);
      const resizer = new ResizeObserver(capture);
      const timer = setTimeout(() => finish(`human choice timed out: ${label}`), timeout);
      observer.observe(host, { subtree: true, childList: true, attributes: true });
      resizer.observe(document.documentElement);
      inspect();
    }, { detailText, label, timeout, token, untilCard: UNTIL_CARD });
    await page.locator(`html[data-idou-human-choice="${token}"]`).waitFor({ state: "attached", timeout: timeout + 5_000 });
    const result = await page.evaluate(token => {
      const choices = globalThis.__idouHumanChoices ?? {};
      const value = choices[token]; delete choices[token];
      if (document.documentElement.getAttribute("data-idou-human-choice") === token) document.documentElement.removeAttribute("data-idou-human-choice");
      return value;
    }, token);
    if (result?.error === "__reached_card__") await reachCard(page, label);
    if (result?.error) throw new Error(result.error);
    return { ...result, id: result?.id ?? null, text: result?.text ?? "" };
  })();
  // Callers arm before starting an operation and await only after the card is
  // ready. If setup fails during that gap, keep Node from reporting this as an
  // unhandled rejection that hides the operation's original assertion.
  pending.catch(() => {});
  return pending;
}

// Manual smokes can coexist with other Electron applications on the same Mac.
// Give the exact fixture window a unique title and keep that process's only
// window above the others while a person is reviewing its card.
export async function presentHumanChoice(app, page, title) {
  if (page.isClosed()) throw new Error("acceptance window closed before the human choice");
  // Stopped before the window is raised: the acceptance run never takes the screen.
  await untilCard(page, title);
  await app.evaluate(({ BrowserWindow }, value) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setTitle(value);
    // Do not call restore(): after a narrow-layout check macOS may restore the
    // fixture to an unrelated previously maximized frame. Keep the exact size
    // and position the acceptance scenario established.
    win?.show(); win?.setAlwaysOnTop(true, "floating"); win?.moveTop(); win?.focus();
  }, title);
}

export async function releaseHumanChoice(app) {
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.setAlwaysOnTop(false);
  });
}

export function waitForHumanConfirm(page, label, options) {
  return waitForHumanChoice(page.locator("#confirmations .confirm-card"), label, options);
}
