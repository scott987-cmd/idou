// Makes a Responses body from the LiteLLM proxy read like one from the model the
// client asked for.
//
// LiteLLM answers with its own model group name ("volc-coding") where the client
// sent a product slug ("GLM-5.3"). The desktop's proposal and synthesis checks
// refuse a response that names another model, and which proxy group serves a
// slug is the control plane's business, not the client's. It also opens some
// output items without fields Codex requires -- a message without content, a
// reasoning item without summary, a function call without arguments. Codex
// drops an output_item.added it cannot parse and then has nowhere to put the
// deltas that follow, so the reply or the call goes missing.
//
// Only those fields change. A frame that needs nothing passes through byte for
// byte; frames are never merged, split, reordered or invented; and anything
// that does not parse is left for the client to judge. Nothing is ever filled
// with content: a missing list becomes empty and missing arguments become "",
// which is what an item that has only just started holds anyway.
import { Transform } from "node:stream";

const REQUIRED = Object.freeze({ message: ["content", []], reasoning: ["summary", []], function_call: ["arguments", ""] });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

// Rewrites one parsed event or body in place and says whether anything changed.
export function normalizeResponse(value, model) {
  if (!object(value)) return false;
  let changed = false;
  if (typeof value.model === "string" && value.model !== model) { value.model = model; changed = true; }
  if (object(value.response) && typeof value.response.model === "string" && value.response.model !== model) { value.response.model = model; changed = true; }
  const item = value.type === "response.output_item.added" && object(value.item) ? value.item : null;
  if (item && typeof item.type === "string" && Object.hasOwn(REQUIRED, item.type)) {
    const [field, fallback] = REQUIRED[item.type];
    if (item[field] === undefined || item[field] === null) { item[field] = Array.isArray(fallback) ? [] : fallback; changed = true; }
  }
  return changed;
}

// The next frame boundary at or after `from`: [index of its first "\n", length].
function boundary(text, from) {
  const lf = text.indexOf("\n\n", from), crlf = text.indexOf("\n\r\n", from);
  if (lf < 0 && crlf < 0) return null;
  return lf >= 0 && (crlf < 0 || lf < crlf) ? [lf, 2] : [crlf, 3];
}
const utf8 = latin1 => Buffer.from(latin1, "latin1").toString("utf8");

export function responseNormalizeTransform({ model, streaming, maxBytes = 8 * 1024 * 1024 }) {
  if (typeof model !== "string" || !model) throw new Error("A client model is required");
  // Held as latin1, one character per byte: the ASCII frame boundaries are found
  // at their byte offsets, a character split across chunks is decoded only once
  // its whole frame has arrived, and an unchanged frame goes back out as exactly
  // the bytes that came in.
  let pending = "", scanned = 0;
  const frame = (raw, text) => {
    const lines = utf8(text).split(/\r?\n/);
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    let event = null;
    if (data && data !== "[DONE]") try { event = JSON.parse(data); } catch { /* not ours to judge */ }
    if (!normalizeResponse(event, model)) return Buffer.from(raw, "latin1");
    return Buffer.from(`${[...lines.filter(line => !line.startsWith("data:")), `data: ${JSON.stringify(event)}`].join("\n")}\n\n`);
  };
  const consume = stream => {
    let found;
    // Resume two characters back so a "\n\r\n" split across chunks is still seen.
    while ((found = boundary(pending, Math.max(0, scanned - 2)))) {
      const [at, length] = found;
      if (at > maxBytes) throw new Error("response frame too large");
      // A CRLF frame ends in "\r\n\r\n"; its trailing "\r" belongs to the separator.
      stream.push(frame(pending.slice(0, at + length), pending.slice(0, at).replace(/\r$/, "")));
      pending = pending.slice(at + length); scanned = 0;
    }
    scanned = pending.length;
    if (pending.length > maxBytes) throw new Error("response frame too large");
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        pending += chunk.toString("latin1");
        if (streaming) consume(this);
        else if (pending.length > maxBytes) throw new Error("response too large");
        callback();
      } catch (error) { callback(error); }
    },
    flush(callback) {
      try {
        // A stream cut short keeps its unterminated tail as it was: completing
        // that event here would make an incomplete one look whole.
        if (streaming) { if (pending) this.push(Buffer.from(pending, "latin1")); }
        else {
          let body = null;
          try { body = JSON.parse(utf8(pending)); } catch { /* not ours to judge */ }
          this.push(normalizeResponse(body, model) ? Buffer.from(JSON.stringify(body)) : Buffer.from(pending, "latin1"));
        }
        callback();
      } catch (error) { callback(error); }
    },
  });
}
