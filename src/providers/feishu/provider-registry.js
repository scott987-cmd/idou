import { SAAS_FEISHU } from "./saas-definition.js";

// The one place a Feishu deployment is chosen. The desktop and the control plane
// each ask here once, at their composition roots, and hand the answer to
// everything they build.
//
// Only deployments this build ships are listed. A deployment is chosen by name
// from that list and never invented from configuration: the origins a person's
// credentials are sent to are part of the code that was reviewed, or part of an
// administrator's deployment that a definition validates -- not whatever a
// setting happens to say. SaaS takes no deployment settings at all; one that is
// given anyway is refused rather than ignored.
//
// Tests pass their own `definitions` to exercise a deployment this build does
// not ship. Nothing in production can.
const BUILT_IN = new Map([[SAAS_FEISHU.id, () => SAAS_FEISHU]]);
export const DEFAULT_FEISHU_PROVIDER = SAAS_FEISHU.id;
export const FEISHU_PROVIDER_IDS = Object.freeze([...BUILT_IN.keys()]);

export function resolveFeishuProvider(id = DEFAULT_FEISHU_PROVIDER, { deployment = null, definitions = BUILT_IN } = {}) {
  const make = typeof id === "string" ? definitions.get(id) : undefined;
  if (!make) throw new Error(`未知的飞书部署类型：${String(id).slice(0, 40)}；本版本支持 ${[...definitions.keys()].join("、")}`);
  if (make.length === 0 && deployment && Object.keys(deployment).length) throw new Error(`飞书部署类型 ${id} 不接受部署地址设置`);
  const definition = make(deployment ?? {});
  if (definition?.id !== id) throw new Error("飞书部署定义与名称不一致");
  return definition;
}
