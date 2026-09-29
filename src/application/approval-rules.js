// Commands a person has said one coding project may run without asking again,
// as Claude Code remembers them per project ("Yes, and don't ask again for …
// in this project"). Kept in the account's own data, never in the project;
// listed in 设置 and forgotten there.
//
// What can be remembered is Codex's own proposal for the command it asked
// about (`proposedExecpolicyAmendment`, a list of words), and only one that
// cannot run arbitrary code or destroy things: not a shell, an interpreter,
// sudo, rm and the like, nor a command Codex could only describe as a shell
// script. What is matched is the command itself, never Codex's proposal for
// it: for `npm test && anything` Codex proposes just `npm test` (measured on
// 0.155.0), so trusting the proposal would run the rest unasked. A command is
// let through only when it is plain words beginning with the remembered ones
// -- no ; & | < > ` $ quotes, globs or line breaks, which is where a second
// command would hide -- and runs inside the project.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Words a remembered command may not start with.
const NEVER = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "env", "eval", "exec", "command", "builtin", "xargs", "nohup",
  "time", "nice", "timeout", "sudo", "su", "doas", "rm", "rmdir", "dd", "mkfs", "shred", "chmod", "chown", "chgrp", "kill", "killall", "pkill",
  "shutdown", "reboot", "halt", "launchctl", "osascript", "security", "open", "python", "python2", "python3", "node", "deno", "bun", "ruby",
  "perl", "php", "lua", "pwsh", "powershell", "rscript", "java", "sqlite3", "mysql", "psql", "ssh", "scp", "rsync"]);
const WORD = /^[A-Za-z0-9_@%+=:,./-]{1,200}$/;
const PLAIN = /^[A-Za-z0-9_@%+=:,./ -]+$/;

// The words to remember for a command Codex asked about, or null when that
// command must go on being asked about.
export function rememberable(proposal) {
  if (!Array.isArray(proposal) || proposal.length === 0 || proposal.length > 8 || !proposal.every((word) => typeof word === "string" && WORD.test(word))) return null;
  const first = path.basename(proposal[0]).toLowerCase();
  if (proposal[0].includes("/") || NEVER.has(first) || /^python\d/.test(first)) return null;
  return [...proposal];
}

// The command as the Agent wrote it, out of the shell Codex runs it in.
function inner(command) {
  const text = String(command ?? "").trim();
  const wrapped = /^\/bin\/(?:zsh|bash|sh) -l?c '([^']*)'$/.exec(text);
  return wrapped ? wrapped[1].trim() : text;
}

// Whether `command` is the remembered words, and nothing but plain words after them.
export function commandMatches(prefix, command) {
  const words = inner(command);
  if (!words || !PLAIN.test(words)) return false;
  const tokens = words.split(/ +/);
  return Array.isArray(prefix) && prefix.length > 0 && prefix.length <= tokens.length && prefix.every((word, index) => tokens[index] === word);
}

const inside = (folder, cwd) => { const relative = path.relative(folder, path.resolve(folder, cwd ?? ".")); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };

export class ApprovalRules {
  #file; #rules;
  constructor(file, rules) { this.#file = file; this.#rules = rules; }
  static async open(file) {
    let rules = [];
    try {
      const stored = JSON.parse(await readFile(file, "utf8"));
      if (stored?.version === 1 && Array.isArray(stored.rules)) rules = stored.rules.filter((rule) => typeof rule?.folder === "string" && path.isAbsolute(rule.folder) && rememberable(rule.prefix));
    } catch (error) { if (error?.code !== "ENOENT") rules = []; }
    return new ApprovalRules(file, rules);
  }
  list() { return this.#rules.map((rule) => ({ folder: rule.folder, prefix: [...rule.prefix], createdAt: rule.createdAt })); }
  // A command Codex asks about in `folder` that a remembered rule covers.
  allows(folder, params) {
    if ((params?.kind ?? "command") !== "command" || typeof params?.command !== "string" || !inside(path.resolve(folder), params.cwd)) return false;
    return this.#rules.some((rule) => rule.folder === path.resolve(folder) && commandMatches(rule.prefix, params.command));
  }
  // What the card can offer to remember for this request, or null.
  offer(params) { return (params?.kind ?? "command") === "command" ? rememberable(params?.proposedExecpolicyAmendment) : null; }
  async remember(folder, prefix) {
    const words = rememberable(prefix);
    if (!words || !path.isAbsolute(folder)) throw new Error("这条命令不能记住");
    const key = path.resolve(folder);
    if (this.#rules.some((rule) => rule.folder === key && rule.prefix.join("\0") === words.join("\0"))) return;
    await this.#save([...this.#rules, { folder: key, prefix: words, createdAt: Date.now() }]);
  }
  async forget(folder, prefix) {
    const key = path.resolve(String(folder ?? "")), words = Array.isArray(prefix) ? prefix.join("\0") : null;
    await this.#save(this.#rules.filter((rule) => !(rule.folder === key && rule.prefix.join("\0") === words)));
  }
  async #save(rules) {
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, rules }), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.#file);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
    this.#rules = rules;
  }
}
