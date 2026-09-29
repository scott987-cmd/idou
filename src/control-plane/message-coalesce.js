// Joins an answer the upstream splits into many messages back into one.
//
// Seen live on 2026-09-19 from MiniMax-M3 behind Codex: the final answer of a
// response came as a run of consecutive assistant messages -- 13, and in the
// application 48, of 80 to 170 characters each -- where one was meant. Codex
// records each as an answer of its own, and its review takes only the last:
// a /review ended as the tail of its findings, JSON that no longer parsed, and
// the conversation showed that fragment. MiniMax's own stream for a plain
// question did not split, so this is not something to ask of the model.
//
// This holds a message's closing events until the next event shows whether the
// answer goes on. If it is another assistant message of the same kind, the close
// and the reopening are dropped and its text carries on under the first
// message's id and position; the close is released at the end with the whole
// text, and the completed response lists the one message. Later items move up by
// the messages folded in. A stream with nothing to join passes through byte for
// byte, and the text is only ever the model's own.
//
// **How long to wait is the next event's to say, not a clock's.** This used to
// give up after 300 ms, on the view that the pieces come back to back. They do
// not once the model has called a tool: measured on 2026-09-21, MiniMax-M3
// answering after two tool results sent its answer as 10 messages of ~135
// characters with 0.56-1.24 s between one's close and the next's start, every
// one of them past the window -- and in the application a 23-piece answer showed
// only its last fragment, the rest folded away as "steps". Holding the close
// costs nothing visible: the text has already gone out as deltas, and whatever
// comes next -- a tool call, the response's end -- releases it at once.
// `holdMs` is only the guard for a stream that goes silent altogether.
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

function boundary(text, from) {
  for (let at = Math.max(0, from); at < text.length - 1; at++) {
    if (text[at] !== "\n") continue;
    if (text[at + 1] === "\n") return [at, 2];
    if (text[at + 1] === "\r" && text[at + 2] === "\n") return [at, 3];
  }
  return null;
}
function parseFrame(raw) {
  const lines = raw.split(/\r?\n/);
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (!data || data === "[DONE]") return { raw, lines, event: null };
  try { const event = JSON.parse(data); return { raw, lines, event: event && typeof event === "object" ? event : null }; } catch { return { raw, lines, event: null }; }
}
const render = (frame, event) => `${[...frame.lines.filter((line) => !line.startsWith("data:")), `data: ${JSON.stringify(event)}`].join("\n")}\n\n`;
const isMessage = (item) => item?.type === "message" && (item.role ?? "assistant") === "assistant";
const sameKind = (a, b) => (a?.phase ?? null) === (b?.phase ?? null);
const textOf = (item) => (Array.isArray(item?.content) ? item.content : []).filter((part) => part?.type === "output_text").map((part) => part.text ?? "").join("");
const withText = (item, text) => ({ ...item, content: [{ ...((item.content ?? []).find((part) => part?.type === "output_text") ?? { type: "output_text", annotations: [] }), text }] });

// A completed response's output with runs of messages joined the same way.
export function coalesceOutput(output) {
  if (!Array.isArray(output)) return output;
  const joined = [];
  for (const item of output) {
    const last = joined.at(-1);
    if (isMessage(item) && isMessage(last) && sameKind(last, item)) joined[joined.length - 1] = withText(last, textOf(last) + textOf(item));
    else joined.push(item);
  }
  return joined;
}

export function messageCoalesceTransform({ maxBytes = 8 * 1024 * 1024, holdMs = 30_000 } = {}) {
  const decoder = new StringDecoder("utf8");
  let pending = "", scanned = 0, shift = 0;
  // The message whose answer may go on: its id, position and item, the text so
  // far, its held closing frames, and whether anything was folded into it.
  let open = null, timer = null;
  const folded = new Map();
  const shifted = (event) => (Number.isInteger(event.output_index) && shift ? { ...event, output_index: event.output_index - shift } : event);
  const emit = (stream, frame, event) => stream.push(event === frame.event && !shift ? `${frame.raw}\n\n` : render(frame, event));
  const release = (stream) => {
    if (!open) return;
    for (const frame of open.held) {
      let event = frame.event;
      if (open.joined) {
        if (event.type === "response.output_text.done") event = { ...event, text: open.text };
        else if (event.type === "response.content_part.done") event = { ...event, part: { ...event.part, text: open.text } };
        else if (event.type === "response.output_item.done") event = { ...event, item: withText(event.item, open.text) };
      }
      stream.push(open.joined || shift ? render(frame, { ...event, output_index: open.outputIndex }) : `${frame.raw}\n\n`);
    }
    open.held = [];
  };
  const handle = (stream, raw) => {
    clearTimeout(timer); timer = null;
    const frame = parseFrame(raw), event = frame.event;
    // A comment or a keep-alive in between neither ends the answer nor moves it.
    if (!event) { stream.push(`${raw}\n\n`); return; }
    const id = event.item_id ?? event.item?.id;
    if (!id && !/^response\.(output_item\.added|completed|incomplete|failed)$|^error$/.test(event.type)) { emit(stream, frame, shifted(event)); return; }
    // Another message straight after a closed one: the same answer, going on.
    if (event.type === "response.output_item.added" && isMessage(event.item) && open?.closed && sameKind(open.item, event.item)) {
      folded.set(event.item.id, open); open.held = []; open.closed = false; open.joined = true; shift += 1; return;
    }
    const target = folded.get(id) ?? (open && id === open.id ? open : null);
    if (target) {
      if (target !== open) { stream.push(render(frame, shifted(event))); return; }
      if (folded.has(id) && event.type === "response.content_part.added") return;
      if (event.type === "response.output_text.delta") open.text += typeof event.delta === "string" ? event.delta : "";
      if (["response.output_text.done", "response.content_part.done", "response.output_item.done"].includes(event.type)) {
        open.held.push({ ...frame, event: folded.has(id) ? { ...event, item_id: open.id, item: event.item ? { ...event.item, id: open.id } : event.item } : event });
        if (event.type === "response.output_item.done") {
          open.closed = true;
          // The stream went quiet altogether: let the client have the close.
          timer = setTimeout(() => { timer = null; release(stream); open = null; }, holdMs);
        }
        return;
      }
      const rewritten = folded.has(id) ? { ...event, item_id: open.id, output_index: open.outputIndex, content_index: 0 } : shifted(event);
      emit(stream, frame, rewritten); return;
    }
    // Anything else ends the answer.
    release(stream);
    if (event.type === "response.output_item.added") {
      open = isMessage(event.item) ? { id: event.item.id, item: event.item, outputIndex: event.output_index - shift, text: textOf(event.item), held: [], closed: false, joined: false } : null;
      emit(stream, frame, shifted(event)); return;
    }
    open = null;
    if (/^response\.(completed|incomplete|failed)$/.test(event.type) && Array.isArray(event.response?.output) && folded.size) {
      stream.push(render(frame, { ...event, response: { ...event.response, output: coalesceOutput(event.response.output) } })); return;
    }
    emit(stream, frame, shifted(event));
  };
  return new Transform({
    destroy(error, callback) { clearTimeout(timer); timer = null; callback(error); },
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
      clearTimeout(timer); timer = null;
      pending += decoder.end();
      if (pending.trim()) handle(this, pending.replace(/\s+$/, ""));
      release(this);
      callback();
    },
  });
}
