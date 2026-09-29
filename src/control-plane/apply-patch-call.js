// A patch the model asked for under the wrong name.
//
// Codex applies a patch when the shell command is exactly `apply_patch <<'EOF'
// ... EOF` (docs/coding-agent.md): it becomes a structured file change with its
// diff, goes through file-change approval, and shows as 修改 a.js +1 −1. These
// models are offered no apply_patch tool -- the product's catalog cannot give
// them one -- but they have seen one in training, and they call it anyway.
// Measured live on 2026-09-19 with MiniMax-M3 fixing a one-line bug: it called
// a function named `apply_patch` with `{"cmd":"apply_patch <<'EOF'\n*** Update
// File: src/sum.js ...\nEOF"}` (and no "*** Begin Patch" line); Codex answered
// "unsupported call: apply_patch", and the model rewrote the file with printf,
// so the change reached the conversation as an opaque command, not a change.
//
// This turns such a call into the call Codex does take: `exec_command` with the
// patch as the whole command, its envelope completed, the same call id and
// working directory. The patch is the model's own; nothing else changes, and a
// stream without such a call passes through byte for byte. It applies only when
// the request offered exec_command and no tool named apply_patch.
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// The patch text, from however the model framed it: a heredoc command, or the
// patch itself under cmd, command, input or patch.
export function patchCommand(argumentsText) {
  let args;
  try { args = JSON.parse(argumentsText); } catch { return null; }
  if (!args || typeof args !== "object") return null;
  const raw = [args.cmd, args.command, args.input, args.patch].map((value) => Array.isArray(value) ? value.join(" ") : value)
    .find((value) => typeof value === "string" && value.trim());
  if (!raw) return null;
  const heredoc = /apply_patch\s*<<\s*['"]?([A-Za-z_]+)['"]?[ \t]*\n([\s\S]*?)\n\1\s*$/.exec(raw.trim());
  let body = (heredoc ? heredoc[2] : raw.replace(/^\s*apply_patch\s+/, "")).replace(/\r\n/g, "\n").trim();
  if (!/\*\*\* (Update|Add|Delete) File: /.test(body)) return null;
  if (!body.startsWith("*** Begin Patch")) body = `*** Begin Patch\n${body}`;
  if (!body.endsWith("*** End Patch")) body = `${body}\n*** End Patch`;
  return JSON.stringify({ cmd: `apply_patch <<'EOF'\n${body}\nEOF`, ...(typeof args.workdir === "string" ? { workdir: args.workdir } : {}) });
}

// Whether a request's tools leave room for this: exec_command offered, and no
// tool of its own called apply_patch.
export function patchCallRewriteApplies(tools) {
  const names = (Array.isArray(tools) ? tools : []).flatMap((tool) => tool?.type === "namespace" ? (tool.tools ?? []).map((inner) => inner?.name) : [tool?.name]);
  return names.includes("exec_command") && !names.includes("apply_patch");
}

function boundary(text, from) {
  for (let at = Math.max(0, from); at < text.length - 1; at++) {
    if (text[at] !== "\n") continue;
    if (text[at + 1] === "\n") return [at, 2];
    if (text[at + 1] === "\r" && text[at + 2] === "\n") return [at, 3];
  }
  return null;
}

export function applyPatchCallTransform({ maxBytes = 8 * 1024 * 1024 } = {}) {
  const decoder = new StringDecoder("utf8");
  let pending = "", scanned = 0;
  // item id -> the arguments gathered so far, for calls named apply_patch.
  const calls = new Map();
  const rewriteItem = (item, args) => {
    const command = patchCommand(args ?? item.arguments ?? "");
    return command ? { ...item, name: "exec_command", arguments: command } : { ...item, arguments: args ?? item.arguments };
  };
  const handle = (stream, raw) => {
    const lines = raw.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    let event = null;
    if (data && data !== "[DONE]") { try { event = JSON.parse(data); } catch { event = null; } }
    if (!event || typeof event !== "object") { stream.push(`${raw}\n\n`); return; }
    const render = (value) => stream.push(`${[...lines.filter((line) => !line.startsWith("data:")), `data: ${JSON.stringify(value)}`].join("\n")}\n\n`);
    const id = event.item_id ?? event.item?.id;
    if (event.type === "response.output_item.added" && event.item?.type === "function_call" && event.item.name === "apply_patch") {
      calls.set(id, "");
      render({ ...event, item: { ...event.item, name: "exec_command", arguments: "" } });
      return;
    }
    if (calls.has(id) && event.type === "response.function_call_arguments.delta") {
      calls.set(id, calls.get(id) + (typeof event.delta === "string" ? event.delta : ""));
      return; // given whole, rewritten, at .done
    }
    if (calls.has(id) && event.type === "response.function_call_arguments.done") {
      const args = typeof event.arguments === "string" && event.arguments ? event.arguments : calls.get(id);
      calls.set(id, args);
      render({ ...event, arguments: patchCommand(args) ?? args });
      return;
    }
    if (event.type === "response.output_item.done" && event.item?.type === "function_call" && (calls.has(id) || event.item.name === "apply_patch")) {
      render({ ...event, item: rewriteItem(event.item, event.item.arguments || calls.get(id)) });
      return;
    }
    if (/^response\.(completed|incomplete|failed)$/.test(event.type) && Array.isArray(event.response?.output)
      && event.response.output.some((item) => item?.type === "function_call" && item.name === "apply_patch")) {
      render({ ...event, response: { ...event.response, output: event.response.output.map((item) => item?.type === "function_call" && item.name === "apply_patch" ? rewriteItem(item) : item) } });
      return;
    }
    stream.push(`${raw}\n\n`);
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += decoder.write(chunk);
      if (pending.length > maxBytes) { callback(new Error("response frame too large")); return; }
      let found;
      while ((found = boundary(pending, scanned))) {
        const [at, width] = found;
        handle(this, pending.slice(0, at));
        pending = pending.slice(at + width); scanned = 0;
      }
      scanned = Math.max(0, pending.length - 2);
      callback();
    },
    flush(callback) {
      pending += decoder.end();
      if (pending.trim()) handle(this, pending.replace(/\s+$/, ""));
      callback();
    },
  });
}
