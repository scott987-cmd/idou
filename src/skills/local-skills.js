import { normalizeSkill, skillDigest } from "./catalog-format.js";

// A skill this person wrote or downloaded, imported from a folder on their own
// machine. It goes through exactly the same shape, size and path checks as a
// signed enterprise skill, and is staged into a task the same way — the only
// difference is provenance: a server signature vouches for one, and the person's
// own explicit confirmation vouches for the other. Nothing here is trusted
// because it is local.
const MAX_FILES = 16;
const ALLOWED = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:md|txt|json|js|py|sh)$/;

function slugify(name) {
  const slug = String(name ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return slug && /^[a-z0-9]/.test(slug) ? slug : null;
}
// The display name may be anything a person wants to call it, including a name
// with no Latin characters at all; the identifier cannot. So the id is taken
// from the first candidate that yields a usable slug — usually the folder.
export function localSkillId(...candidates) {
  for (const candidate of candidates) { const slug = slugify(candidate); if (slug) return `local-${slug}`; }
  throw new Error("无法从技能名或文件夹名生成标识，请把文件夹改成字母、数字或连字符");
}

// Minimal front matter: the two fields a skill actually declares about itself.
// Anything else in the block is ignored rather than guessed at.
export function readFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text ?? ""));
  if (!match) return { fields: {}, body: String(text ?? "") };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][A-Za-z0-9_-]{0,39})\s*:\s*(.*)$/.exec(line.trim());
    if (!pair) continue;
    fields[pair[1].toLowerCase()] = pair[2].replace(/^["']|["']$/g, "").trim();
  }
  return { fields, body: String(text).slice(match[0].length) };
}

// Codex identifies a staged skill by the name in its front matter, and the task
// runner requires that name to equal the reference id. So the stored copy is
// rewritten to agree with the id it was given; the folder on disk is untouched.
export function withSkillName(text, id) {
  const { fields, body } = readFrontMatter(text);
  const description = fields.description ? `description: ${fields.description}\n` : "";
  return `---\nname: ${id}\n${description}---\n${body.replace(/^\r?\n/, "")}`;
}

// Putting a locally imported skill on the enterprise shelf.
//
// The catalogue carries enterprise skills only: a folder someone imported is
// admitted by that person's own confirmation, a shelf entry is admitted by the
// server's signature. Publishing is exactly the step where that changes, so it
// is a real conversion rather than a flag -- the identity changes, and SKILL.md
// is rewritten to agree with it, the same way importing does. The folder on
// disk is untouched.
//
// Tool declarations are deliberately NOT carried over. A local skill declares
// none (admitting them from an unsigned folder would let a file grant itself
// authority), and publishing must not become the loophole that grants them.
export function promoteToEnterprise(skill, { publisher }) {
  if (!skill?.id?.startsWith("local-")) throw new Error("只有本机导入的技能需要上架转换");
  if (typeof publisher !== "string" || !publisher.trim()) throw new Error("上架需要标明发布者");
  const id = `enterprise-${skill.id.slice("local-".length)}`;
  const bundle = {
    id, version: skill.version, title: skill.title, description: skill.description,
    publisher: publisher.trim().slice(0, 120), requiredTools: [], runtimeVersions: { codex: [], feishu: [] },
    files: skill.files.map((file) => file.path === "SKILL.md" ? { path: file.path, text: withSkillName(file.text, id) } : { path: file.path, text: file.text }),
  };
  const normalized = normalizeSkill(bundle);
  return { ...normalized, digest: skillDigest(normalized) };
}

export function buildLocalSkill({ files, folderName, version = "1.0.0" }) {
  const entries = (files ?? []).filter((file) => ALLOWED.test(file.path));
  const main = entries.find((file) => file.path === "SKILL.md");
  if (!main) throw new Error("这个文件夹里没有 SKILL.md，不能作为技能导入");
  if (entries.length > MAX_FILES) throw new Error(`技能最多 ${MAX_FILES} 个文件`);
  const { fields } = readFrontMatter(main.text);
  const id = localSkillId(fields.name, folderName);
  const skill = {
    id, version: /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(fields.version ?? "") ? fields.version : version,
    title: (fields.name || folderName || id).slice(0, 160),
    description: (fields.description || "本机导入的技能").slice(0, 600),
    publisher: "本机导入",
    // Locally imported skills declare no tools. Admitting tool declarations from
    // an unsigned folder would let a file grant itself authority; a skill that
    // needs tools has to come through the reviewed catalog.
    requiredTools: [],
    runtimeVersions: { codex: [], feishu: [] },
    files: entries.map((file) => file.path === "SKILL.md" ? { path: file.path, text: withSkillName(file.text, id) } : { path: file.path, text: file.text }),
  };
  const normalized = normalizeSkill(skill);
  return { ...normalized, digest: skillDigest(normalized), compatible: true, source: "local" };
}
