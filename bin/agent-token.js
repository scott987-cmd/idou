#!/usr/bin/env node
import "../src/adopt-legacy-env.js";
import { readClientSession } from "../src/control-plane/client-session.js";

const [sessionFile, serverUrl, ...extra] = process.argv.slice(2);
try {
  if (extra.length || !serverUrl) throw new Error("Expected session file and server URL");
  const session = await readClientSession(sessionFile, serverUrl);
  process.stdout.write(session.token);
} catch {
  process.stderr.write("Agent session unavailable or expired; reconnect to the application.\n");
  process.exitCode = 1;
}
