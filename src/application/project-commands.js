// Commands a project defines for itself, as Claude Code reads them from
// .claude/commands/*.md and Codex its custom prompts: a Markdown file, an
// optional front matter with a description and an argument hint, and a text
// that is sent as the message, with $ARGUMENTS -- and $1 to $9, word by word --
// filled in from what follows the command. A command only puts words in the
// person's mouth; it runs nothing by itself (Claude Code's `!` lines are not
// supported and stay as text).
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

// The product's own slash commands (SLASH_COMMANDS in the renderer): a project
// command by one of these names is left to them.
export const PRODUCT_COMMANDS = Object.freeze(["undo", "compact", "diff", "review", "init", "new", "permissions", "model", "status"]);
const FOLDERS = Object.freeze([".claude/commands", ".codex/prompts"]);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_BYTES = 64 * 1024;
const MAX_FILES = 200;
const MAX_ENTRIES = 2_000;

// The front matter's description and argument hint, and the text after it.
export function parseCommand(text) {
  const source = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const head = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  const fields = {};
  for (const line of head ? head[1].split("\n") : []) {
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (pair) fields[pair[1].toLowerCase()] = pair[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { description: (fields.description ?? "").slice(0, 200), argumentHint: (fields["argument-hint"] ?? "").slice(0, 120),
    body: (head ? source.slice(head[0].length) : source).trim() };
}

// The command's text with what was typed after it filled in. Words given to a
// command that asks for none are added at the end rather than dropped.
export function expandCommand(body, args = "") {
  const given = String(args ?? "").trim(), words = given ? given.split(/\s+/u) : [];
  if (!/\$ARGUMENTS|\$[1-9]/.test(body)) return given ? `${body}\n\n${given}` : body;
  // One pass, so what the person typed is never filled in again.
  return body.replace(/\$(ARGUMENTS|[1-9])/g, (_, which) => which === "ARGUMENTS" ? given : words[Number(which) - 1] ?? "");
}

// Every command file of the project, read only from inside it: a link that
// leads out of the folder is not followed. Subdirectories form the command's
// relative name, so equal basenames do not silently shadow each other. There
// is no arbitrary depth limit; the total number of visited entries and files
// is bounded instead.
async function commandFiles(cwd) {
  const root = await realpath(cwd);
  const found = [], directories = FOLDERS.map((folder) => ({ directory: path.join(root, folder), folder }));
  let visited = 0;
  while (directories.length && found.length < MAX_FILES && visited < MAX_ENTRIES) {
    const { directory, folder } = directories.shift();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > MAX_ENTRIES || found.length >= MAX_FILES) break;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (NAME.test(entry.name)) directories.push({ directory: file, folder });
        continue;
      }
      const basename = entry.name.endsWith(".md") ? entry.name.slice(0, -3) : "";
      if (!NAME.test(basename)) continue;
      const real = await realpath(file).catch(() => null);
      if (!real || !real.startsWith(`${root}${path.sep}`)) continue;
      const info = await lstat(real).catch(() => null);
      if (!info?.isFile() || info.size > MAX_BYTES) continue;
      const source = path.relative(root, file);
      const relative = path.relative(path.join(root, folder), file).split(path.sep).join("/");
      found.push({ name: relative.slice(0, -3), basename, file: real, source });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
}

async function readCommands(cwd, { reserved = [] } = {}) {
  const blocked = new Set(reserved.map((name) => String(name).toLowerCase())), taken = new Set(), commands = [];
  for (const file of await commandFiles(cwd)) {
    const key = file.name.toLowerCase();
    if (blocked.has(key) || taken.has(key)) continue;
    const { description, argumentHint, body } = parseCommand(await readFile(file.file, "utf8"));
    if (!body) continue;
    taken.add(key);
    commands.push({ name: file.name, basename: file.basename, description, argumentHint, source: file.source,
      takesArguments: /\$ARGUMENTS|\$[1-9]/.test(body), body });
  }
  const counts = new Map();
  for (const command of commands) counts.set(command.basename.toLowerCase(), (counts.get(command.basename.toLowerCase()) ?? 0) + 1);
  return commands.map((command) => ({ ...command,
    aliases: command.name !== command.basename && !blocked.has(command.basename.toLowerCase()) && counts.get(command.basename.toLowerCase()) === 1 ? [command.basename] : [] }));
}

export async function listProjectCommands(cwd, options = {}) {
  return (await readCommands(cwd, options)).map(({ basename: _basename, body: _body, ...command }) => command);
}

// One command, filled in, ready to be sent as a message.
export async function projectCommand(cwd, name, args, { reserved = [] } = {}) {
  const wanted = String(name ?? "").toLowerCase(), commands = await readCommands(cwd, { reserved });
  let command = commands.find((row) => row.name.toLowerCase() === wanted);
  if (!command) {
    const legacy = commands.filter((row) => row.basename.toLowerCase() === wanted);
    if (legacy.length > 1) throw new Error(`项目命令 /${String(name ?? "").slice(0, 64)} 有多个候选：${legacy.map((row) => `/${row.name}`).join("、")}；请使用完整相对路径`);
    command = legacy.length === 1 && legacy[0].aliases.length ? legacy[0] : null;
  }
  if (!command) throw new Error(`项目里没有 /${String(name ?? "").slice(0, 64)} 这个命令`);
  const text = expandCommand(command.body, args);
  if (text.length > 100_000) throw new Error("命令展开后太长了");
  return { name: command.name, source: command.source, text };
}
