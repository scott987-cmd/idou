import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const PREFIX = "idou_mcp_";
const namespaceName = (value) => typeof value === "string" && /^mcp__[a-z][a-z0-9_-]{0,39}$/.test(value);
const functionName = (value) => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(value);
const alias = (namespace, name) => PREFIX + createHash("sha256").update(JSON.stringify([namespace, name])).digest("hex").slice(0, 48);
const invalid = () => { throw new Error("Invalid MCP namespace tool wire format"); };
// Codex's own subagent tools, offered as one namespace once subagents are on --
// measured on the pinned 0.147.0: exactly these six function tools, under this
// name. They are Codex's tools, not an MCP server's, so they keep their own names
// and descriptions (Codex's instructions and the descriptions themselves call
// them spawn_agent and wait_agent); only the namespace envelope comes off on the
// way out and goes back on in the answer. Both the name and the list are closed:
// any other namespace outside mcp__, or any other tool inside this one, is refused.
const AGENT_NAMESPACE = "collaboration";
const AGENT_TOOLS = new Set(["followup_task", "interrupt_agent", "list_agents", "send_message", "spawn_agent", "wait_agent"]);
// Agents of one task talk through `agent_message` input items: a parent's task for
// a child, a child's final answer for its parent. LiteLLM drops that item type
// without a word (measured on GLM-5.3: the model repeated a code it was sent as a
// user message, and never saw the same code sent as an agent_message), so a child
// got no task and a parent waited for nothing. Each goes to the provider as a user
// message instead, saying which agent sent it to which. Two part shapes are
// measured: text, and the `encrypted_content` part a task's own words arrive in --
// Codex marks spawn_agent's message as encrypted, and with a provider that does
// not encrypt, the part simply holds the text. Task paths at both ends and those
// two parts only; anything else fails the request instead of vanishing.
const AGENT_PATH = /^\/root(?:\/[A-Za-z0-9_.-]{1,64}){0,16}$/;
const partText = (part) => part?.type === "input_text" && typeof part.text === "string" ? part.text
  : part?.type === "encrypted_content" && typeof part.encrypted_content === "string" ? part.encrypted_content : null;
function agentMessage(item) {
  if (!AGENT_PATH.test(item.author ?? "") || !AGENT_PATH.test(item.recipient ?? "") || !Array.isArray(item.content) || !item.content.length
    || item.content.some((part) => partText(part) === null)) return invalid();
  // Codex's header part already ends in the newline before the payload part.
  const text = item.content.map(partText).join("");
  return { type: "message", role: "user", content: [{ type: "input_text", text: `[同一任务里的 agent ${item.author} 发给 ${item.recipient} 的消息（由 agent 转达，不是用户本人说的）：]\n\n${text}` }] };
}

// The gateway forwards ordinary function definitions to MiniMax. Only tool
// envelopes are translated -- and a subagent's messages, above -- while argument
// strings, source text and results are not.
export function flattenMcpTools(body) {
  const aliases = new Map(), names = new Set();
  const flattenCall = (item) => {
    if (item?.type === "agent_message") return agentMessage(item);
    if (!item || item.type !== "function_call" || !item.namespace) return item;
    if (item.namespace === "functions" && functionName(item.name) && !item.name.startsWith(PREFIX)) { const { namespace, ...rest } = item; return rest; }
    if (item.namespace === AGENT_NAMESPACE && AGENT_TOOLS.has(item.name)) { const { namespace, ...rest } = item; return rest; }
    if (!namespaceName(item.namespace) || !functionName(item.name)) return invalid();
    const { namespace, ...rest } = item; return { ...rest, name: alias(namespace, item.name) };
  };
  const tools = body.tools?.flatMap((tool) => {
    if (tool?.type === "function") {
      if (!functionName(tool.name) || tool.name.startsWith(PREFIX) || names.has(tool.name)) return invalid(); names.add(tool.name); return [tool];
    }
    if (tool?.type === "namespace" && tool.name === AGENT_NAMESPACE) {
      if (!Array.isArray(tool.tools) || !tool.tools.length || tool.tools.length > AGENT_TOOLS.size) return invalid();
      return tool.tools.map((fn) => {
        if (fn?.type !== "function" || !AGENT_TOOLS.has(fn.name) || names.has(fn.name)) return invalid();
        names.add(fn.name); aliases.set(fn.name, { namespace: AGENT_NAMESPACE, name: fn.name });
        return fn;
      });
    }
    if (tool?.type !== "namespace" || !namespaceName(tool.name) || !Array.isArray(tool.tools) || !tool.tools.length || tool.tools.length > 32) return invalid();
    return tool.tools.map((fn) => {
      if (fn?.type !== "function" || !functionName(fn.name)) return invalid();
      const name = alias(tool.name, fn.name); if (names.has(name)) return invalid(); names.add(name);
      aliases.set(name, { namespace: tool.name, name: fn.name });
      // The alias is opaque on purpose (length limits, no collision with real
      // tool names), which also hid from the model which server and tool it
      // stands for: asked to "use deepwiki's read_wiki_structure", it found no
      // such tool and refused. Both names are regex-checked above, so saying
      // them in the description cannot smuggle anything in.
      const origin = `来自 MCP 服务「${tool.name.slice("mcp__".length)}」的工具 ${fn.name}。`;
      return { ...fn, name, description: typeof fn.description === "string" && fn.description ? `${origin}${fn.description}` : origin };
    });
  });
  if (tools?.length > 256) return invalid();
  let toolChoice = body.tool_choice;
  if (toolChoice?.namespace) {
    if (toolChoice.type !== "function" || !functionName(toolChoice.name)) return invalid();
    if (toolChoice.namespace === AGENT_NAMESPACE) {
      if (aliases.get(toolChoice.name)?.namespace !== AGENT_NAMESPACE) return invalid();
      const { namespace, ...rest } = toolChoice; toolChoice = rest;
    } else {
      if (!namespaceName(toolChoice.namespace)) return invalid();
      const { namespace, ...rest } = toolChoice; toolChoice = { ...rest, name: alias(namespace, toolChoice.name) };
      if (!aliases.has(toolChoice.name)) return invalid();
    }
  }
  return { aliases, body: { ...body, ...(tools ? { tools } : {}), ...(Array.isArray(body.input) ? { input: body.input.map(flattenCall) } : {}), ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}) } };
}

export function restoreMcpResponse(value, aliases) {
  const item = (entry) => entry?.type === "function_call" && aliases.has(entry.name) ? { ...entry, ...aliases.get(entry.name) } : entry;
  const response = (entry) => entry && Array.isArray(entry.output) ? { ...entry, output: entry.output.map(item) } : entry;
  return response({ ...value, ...(value.item ? { item: item(value.item) } : {}), ...(value.response ? { response: response(value.response) } : {}) });
}

// Bounded SSE frame buffering, preserving streaming/backpressure and UTF-8
// boundaries. A malformed/truncated event fails the stream, never completes it.
// The bound is the gateway's request bound, as in the other two stages: LiteLLM
// echoes the request's tools into response.created, so under a 1 MiB bound a
// large MCP tool set killed every GLM turn at its first frame (review, 2026-09-11).
// The scan resumes where it stopped and bytes are counted as they arrive, so a
// frame that size still costs linear time on the event loop.
export function mcpResponseTransform(aliases, streaming, maxBytes = 8 * 1024 * 1024) {
  let pending = "", bytes = 0, scanned = 0; const decoder = new StringDecoder("utf8");
  const append = (text) => { pending += text; bytes += Buffer.byteLength(text); };
  const frame = (value) => {
    const lines = value.split(/\r?\n/), data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return `${value}\n\n`;
    const restored = restoreMcpResponse(JSON.parse(data), aliases);
    return `${[...lines.filter((line) => !line.startsWith("data:")), `data: ${JSON.stringify(restored)}`].join("\n")}\n\n`;
  };
  const consume = (stream) => {
    if (streaming) {
      // Resume three characters back so a "\r\n\r\n" split across chunks is still seen.
      const separator = /\r?\n\r?\n/g; separator.lastIndex = Math.max(0, scanned - 3);
      let match;
      while ((match = separator.exec(pending))) {
        const value = pending.slice(0, match.index), size = Buffer.byteLength(value); if (size > maxBytes) throw new Error("MCP response frame too large");
        pending = pending.slice(match.index + match[0].length); bytes -= size + match[0].length; separator.lastIndex = 0; stream.push(frame(value));
      }
      scanned = pending.length;
    }
    if (bytes > maxBytes) throw new Error("MCP response too large");
  };
  return new Transform({
    transform(chunk, _encoding, callback) { try { append(decoder.write(chunk)); consume(this); callback(); } catch { callback(new Error("Invalid MCP model response")); } },
    flush(callback) { try { append(decoder.end()); consume(this); if (streaming) { if (pending.trim()) throw new Error(); } else this.push(JSON.stringify(restoreMcpResponse(JSON.parse(pending), aliases))); callback(); } catch { callback(new Error("Incomplete MCP model response")); } },
  });
}
