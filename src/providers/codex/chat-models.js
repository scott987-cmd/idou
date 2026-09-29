// The chat models the product knows how to run, keyed by the slug the desktop,
// the Codex catalog and the control plane all use. The control plane enforces
// exactly one of them (the one it is configured for) and says which on
// /healthz; the desktop accepts only a slug listed here, so a server can never
// make Codex run with metadata the product did not ship.
//
// MiniMax-M3 is MiniMax's own Responses API. GLM-5.3 is Zhipu's model served
// by Volcengine Ark and reached through a LiteLLM proxy on the control plane's
// own machine; the control plane maps the slug to the proxy's model group.
// Images stay on MiniMax whichever chat model is in use; video goes to Qwen
// when the server has a Token Plan key (server-config.js loadVideoKey).
//
// `sideCalls` bounds the tool-free JSON requests the desktop makes outside Codex
// (document/sheet proposals, Wiki synthesis): one non-streaming call, never
// retried. GLM-5.3 always reasons first and its reasoning counts against
// max_output_tokens, so a budget sized for MiniMax can run out before the JSON
// starts; that ends "incomplete", which these clients refuse after the call was
// billed. Live on 2026-09-11/12 the synthesis smoke's 103-character source
// used 1851 total tokens on GLM-5.3, against 840 on MiniMax-M3. The gateway
// refuses a max_output_tokens above its own cap (32768 for GLM), so 8192 is
// accepted; the longer answer gets a longer client timeout, still well inside
// the gateway's 600 s GLM upstream timeout. MiniMax keeps exactly the budgets it
// always had.
import { readFileSync } from "node:fs";
const sideCalls = (proposalTokens, synthesisTokens, timeoutMs) => Object.freeze({
  proposal: Object.freeze({ maxOutputTokens: proposalTokens, timeoutMs }),
  synthesis: Object.freeze({ maxOutputTokens: synthesisTokens, timeoutMs }),
});
export const CHAT_MODELS = Object.freeze({
  "MiniMax-M3": Object.freeze({ provider: "minimax", label: "MiniMax-M3", vendor: "MiniMax", sideCalls: sideCalls(3000, 2400, 90_000) }),
  "GLM-5.3": Object.freeze({ provider: "litellm", label: "GLM-5.3", vendor: "智谱 GLM（火山方舟，经服务端本机 LiteLLM）", sideCalls: sideCalls(8192, 8192, 180_000) }),
});
export const DEFAULT_CHAT_MODEL = "MiniMax-M3";
export const isChatModel = value => typeof value === "string" && Object.hasOwn(CHAT_MODELS, value);
// "GLM-5.3（智谱 GLM（火山方舟，经服务端本机 LiteLLM））" reads badly; the label
// and the vendor are shown separately where both are needed.
export const chatModelLabel = value => isChatModel(value) ? CHAT_MODELS[value].label : String(value ?? "");
export const chatModelVendor = value => isChatModel(value) ? CHAT_MODELS[value].vendor : "";
// Whether a model sees an image pasted with a message: the Codex catalog's own
// input_modalities, which is what Codex decides by (a model without "image"
// is sent "image content omitted because you do not support image input").
const catalog = JSON.parse(readFileSync(new URL("./model-catalog.json", import.meta.url), "utf8"));
export const chatModelSeesImages = value => catalog.models.some((entry) => entry.slug === value && Array.isArray(entry.input_modalities) && entry.input_modalities.includes("image"));
