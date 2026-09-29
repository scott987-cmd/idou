// Test-only stand-in for the Feishu provider registry: everything the real one
// ships, plus the private fixture (private-feishu.js) by name. Its in-memory
// Feishu is on globalThis so a script can change who may read what.
import { DEFAULT_FEISHU_PROVIDER, FEISHU_PROVIDER_IDS, resolveFeishuProvider as shipped } from "../../src/providers/feishu/provider-registry.js";
import { PRIVATE_DEPLOYMENT, PRIVATE_ID, privateFeishu, privateUser } from "./private-feishu.js";

export { DEFAULT_FEISHU_PROVIDER, FEISHU_PROVIDER_IDS };

const fixture = globalThis.privateDeploymentFixture ??= { documents: new Map(), folders: new Map(), user: privateUser("alice"), resolved: [] };
let definition = null;

export function resolveFeishuProvider(id, options) {
  fixture.resolved.push(String(id));
  if (id !== PRIVATE_ID) return shipped(id, options);
  definition ??= privateFeishu(PRIVATE_DEPLOYMENT, { documents: fixture.documents, folders: fixture.folders, user: () => fixture.user });
  return definition;
}
