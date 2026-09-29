import { readFile } from "node:fs/promises";
import { validateServerUrl } from "../control-plane/client-session.js";

// Opened from Finder, a packaged app has no environment and no working directory
// to read a configuration from, so it would have no control plane at all -- and
// would skip a sign-in it could have resumed, leaving the person at a signed-out
// window with their account still on disk. The address of the control plane that
// account last signed in to is written beside it; this reads it back. An explicit
// setting always wins, and anything unreadable or not a control-plane address
// leaves the app exactly as it was: signed out, saying so.
export function rememberedServerUrl(pointer, validate = validateServerUrl) {
  const value = pointer?.serverUrl;
  if (typeof value !== "string") return null;
  try { return validate(value); } catch { return null; }
}

export async function rememberedServerFile(filename, read = readFile, validate = validateServerUrl) {
  try { return rememberedServerUrl(JSON.parse(await read(filename, "utf8")), validate); }
  catch { return null; }
}
