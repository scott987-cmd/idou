// What a command runs, as opposed to what it only mentions. Step titles and
// the headline of an approval card are chosen from this, and the person reads
// that headline to decide, so it has to name something the command executes.
//
// 2026-09-23: a work step that rewrote media-adoption.md -- whose text said
// "media-create --kind video" -- was titled 生成视频, because the name was
// looked for anywhere in the command. The approval card was built the same
// way, so a command that merely wrote a note mentioning doc-create would have
// been headlined 确认创建飞书文档.
//
// Display only: nothing here authorizes anything, and the full command always
// stays in the technical details.

// A heredoc's body is data being written, never a command. The delimiter may
// sit in any quoting (<<'EOF', <<"EOF", or <<'"'"'EOF'"'"' inside a
// single-quoted zsh -c), and <<< is a here-string, not a heredoc.
const HEREDOC = /(?<!<)<<(-?)[ \t]*['"\\]*([A-Za-z_][A-Za-z0-9_]*)/;

export function executedText(command) {
  // A backslash-newline continues the same command line.
  const lines = String(command ?? "").replace(/\\+\r?\n/g, " ").split("\n"), kept = [];
  let until = null, tabs = false;
  for (const line of lines) {
    if (until !== null) {
      if ((tabs ? line.replace(/^\t+/, "") : line) === until) until = null;
      continue;
    }
    kept.push(line);
    const match = HEREDOC.exec(line);
    if (match) { until = match[2]; tabs = match[1] === "-"; }
  }
  return kept.join("\n");
}

// Where a command word may start: the beginning, a space, a quote, or a shell
// operator. Not a backtick: `agent.js media-create` in a note is prose.
const START = String.raw`(?:^|[\s"'(=;&|\\])`;
// A path token ending in the tool's name, then the quote that may close it.
const tool = (name) => String.raw`[^\s\`'"\\]*${name}\\?["']?[ \t]+`;
const AGENT = new RegExp(`${START}${tool(String.raw`agent\.js`)}([a-z][a-z-]*)([^\\n;&|]*)`, "g");
const LARK = new RegExp(`${START}${tool("lark-cli")}(?:[^\\n;&|]*?[ \\t])?(sheets|base|calendar|task)[ \\t]+\\+([a-z][a-z-]*)`);

// Each office action the command runs, in order, with the rest of its line
// (where its options are).
export function agentActions(command) {
  return [...executedText(command).matchAll(AGENT)].map(([, action, rest]) => ({ action, rest }));
}

// The Feishu CLI shortcut the command runs, if any: lark-cli <domain> +<verb>.
export function larkShortcut(command) {
  const match = LARK.exec(executedText(command));
  return match ? { domain: match[1], verb: match[2] } : null;
}

// An option's value from an action's own arguments. Inside a double-quoted
// zsh -c the value's quotes arrive escaped (\"...\"), as the task record keeps them.
export function optionValue(rest, name) {
  const match = new RegExp(`--${name}\\s+(?:\\\\?"((?:[^"\\\\]|\\\\(?!"))*)\\\\?"|'([^']*)'|([^\\s'";\\\\]+))`).exec(String(rest ?? ""));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "").slice(0, 160) : "";
}
