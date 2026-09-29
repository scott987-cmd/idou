// Electron wraps every rejection from the main process as
// "Error invoking remote method 'idou:x': Error: …". The part after that is
// the sentence written for the person; the wrapper is an internal method name
// that means nothing to them and must never reach the screen.
export function readableError(cause) {
  return String(cause?.message ?? cause ?? "")
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^(?:Error|TypeError):\s*/, "")
    .trim() || "操作失败，请重试";
}
