// Repairs one way the upstream Responses stream breaks tool calls.
//
// Seen live on 2026-09-11 from MiniMax-M3: a function call is closed before its
// arguments are sent. The stream carries output_item.added, then
// function_call_arguments.done and output_item.done with `arguments: ""`, and
// only after that the function_call_arguments.delta events holding the actual
// JSON; the complete call appears once more in response.completed. Codex takes
// a call from its output_item.done, so every tool call in an affected session
// arrived empty ("failed to parse function arguments: EOF while parsing") and
// the Agent could not run a single command. Earlier the same day the stream was
// in the documented order, which is why this surfaced only intermittently.
//
// This holds a function call's closing events while its arguments are empty,
// forwards the deltas that follow, and releases the closing events with the
// arguments filled in: when the next output item starts, or at the latest from
// the completed response. A stream already in order passes through byte for
// byte, text still streams as it arrives, and nothing is ever invented: the
// arguments are the model's own, taken from its deltas or its final output.
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// Where the next frame boundary is, searching only from `from`, so a large
// frame arriving in many chunks is scanned once rather than once per chunk.
function boundary(text, from) {
  for (let at = Math.max(0, from); at < text.length - 1; at++) {
    if (text[at] !== "\n") continue;
    if (text[at + 1] === "\n") return [at, 2];
    if (text[at + 1] === "\r" && text[at + 2] === "\n") return [at, 3];
  }
  return null;
}
const empty = value => value === undefined || value === null || value === "";

function parseFrame(frame) {
  const lines = frame.split(/\r?\n/);
  const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
  if (!data || data === "[DONE]") return null;
  try { const event = JSON.parse(data); return event && typeof event === "object" ? { lines, event } : null; } catch { return null; }
}
const render = ({ lines, event }) => `${[...lines.filter(line => !line.startsWith("data:")), `data: ${JSON.stringify(event)}`].join("\n")}\n\n`;

export function functionCallRepairTransform({ maxBytes = 8 * 1024 * 1024 } = {}) {
  const decoder = new StringDecoder("utf8");
  let pending = "", scanned = 0;
  // item id -> { frames: parsed closing frames in arrival order, args: deltas received after closing }
  const held = new Map();
  const itemId = event => event.item_id ?? event.item?.id;
  const release = (stream, fromCompleted = null) => {
    for (const [id, entry] of held) {
      const final = fromCompleted?.find(item => item?.type === "function_call" && (item.id === id || item.call_id === entry.callId));
      const args = entry.args || (typeof final?.arguments === "string" ? final.arguments : "");
      for (const frame of entry.frames) {
        if (frame.event.type === "response.function_call_arguments.done") frame.event.arguments = args;
        else frame.event.item = { ...frame.event.item, arguments: args };
        stream.push(render(frame));
      }
    }
    held.clear();
  };
  const handle = (stream, raw) => {
    const parsed = parseFrame(raw);
    if (!parsed) { stream.push(`${raw}\n\n`); return; }
    const { event } = parsed, type = event.type, id = itemId(event);
    if (type === "response.output_item.added") { release(stream); stream.push(`${raw}\n\n`); return; }
    if (type === "response.function_call_arguments.delta" && held.has(id)) {
      held.get(id).args += typeof event.delta === "string" ? event.delta : "";
      stream.push(`${raw}\n\n`); return;
    }
    if (type === "response.function_call_arguments.done" && (empty(event.arguments) || held.has(id))) {
      const entry = held.get(id) ?? { frames: [], args: "", callId: null };
      entry.frames.push(parsed); held.set(id, entry); return;
    }
    if (type === "response.output_item.done" && event.item?.type === "function_call" && (empty(event.item.arguments) || held.has(id))) {
      const entry = held.get(id) ?? { frames: [], args: "", callId: null };
      entry.callId = event.item.call_id ?? entry.callId;
      entry.frames.push(parsed); held.set(id, entry); return;
    }
    if (/^response\.(completed|incomplete|failed)$/.test(type)) { release(stream, Array.isArray(event.response?.output) ? event.response.output : null); stream.push(`${raw}\n\n`); return; }
    stream.push(`${raw}\n\n`);
  };
  const consume = stream => {
    let found;
    while ((found = boundary(pending, scanned - 2))) {
      const [at, length] = found;
      // A CRLF frame ends in "\r\n\r\n"; its trailing "\r" belongs to the separator.
      const raw = pending.slice(0, at).replace(/\r$/, "");
      pending = pending.slice(at + length); scanned = 0;
      if (Buffer.byteLength(raw) > maxBytes) throw new Error("response frame too large");
      handle(stream, raw);
    }
    scanned = pending.length;
    if (Buffer.byteLength(pending) > maxBytes) throw new Error("response frame too large");
  };
  return new Transform({
    transform(chunk, _encoding, callback) { try { pending += decoder.write(chunk); consume(this); callback(); } catch (error) { callback(error); } },
    flush(callback) {
      try {
        pending += decoder.end(); consume(this);
        release(this); // A stream cut short still gets back what it had.
        if (pending) this.push(pending);
        callback();
      } catch (error) { callback(error); }
    },
  });
}
