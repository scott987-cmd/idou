// Values in an Agent's environment that must never be kept in a task's record
// or drawn on screen: the write bridge's key, the Feishu sidecar's proxy key,
// an MCP lease. The Agent needs them to work, so it can always print them: on
// 2026-09-23 one ran `env` looking for a setting, and the bridge key went into
// the task's record and onto the step's details, in a screen being recorded.
//
// Chosen by name, over the whole environment the runtime starts with, so a
// credential added later is covered without anyone remembering this list.
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/;
// Shorter values would redact ordinary words; no credential this application
// hands out is anywhere near this short.
const MIN_LENGTH = 12;
export const REDACTED = "〔已隐藏〕";

export function secretValues(env = {}) {
  return [...new Set(Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.length >= MIN_LENGTH)
    .map(([, value]) => value))];
}

// NAME=value where the name says it is a credential -- what `env`, `printenv`
// or a dotenv file prints. Caught whether or not the value is one this
// application handed out, and in records written before any of this existed.
const ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)=([^\s'"]{8,})/g;
export const redactAssignments = (text) => typeof text !== "string" ? text : text.replace(ASSIGNMENT, (_match, name) => `${name}=${REDACTED}`);

// Longest first, so a value that contains another is hidden whole.
export function redactor(values = []) {
  const list = [...new Set(values)].filter((value) => typeof value === "string" && value.length >= MIN_LENGTH).sort((a, b) => b.length - a.length);
  return (text) => typeof text !== "string" ? text : redactAssignments(list.reduce((out, value) => out.split(value).join(REDACTED), text));
}
