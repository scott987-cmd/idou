// Product capability policy, independent of which SaaS/private CLI is bundled.
// This product builds and hosts its own apps; Miaoda is not a dependency.
export const APPLICATION_PLATFORM_INSTRUCTIONS = "This product does not use Miaoda or Spark. Do not invoke lark-cli apps, load lark-apps, or create/publish a Miaoda application. Build requested applications inside the authorized local workspace using coding tools. Enterprise deployment uses this product's own platform; it is not available yet. Never claim an application is deployed because a local preview works.";
export function isProductSkill(name) { return typeof name === "string" && /^lark-[a-z0-9-]+$/.test(name) && name !== "lark-apps"; }
export function productSkillCatalog(skills) { return skills.filter((skill) => isProductSkill(typeof skill === "string" ? skill : skill.name)); }
