import test from "node:test";
import assert from "node:assert/strict";
import { ModelVisibility, chatMembership, modelPolicy, VISIBILITY_LIMITS } from "../src/control-plane/model-visibility.js";

const MODELS = ["MiniMax-M3", "GLM-5.3", "Kimi-K2"];
const policy = (rules) => modelPolicy(rules, { models: MODELS });

test("a rule naming a model this server does not offer is refused at startup", () => {
  assert.equal(modelPolicy(null, { models: MODELS }), null);
  assert.equal(modelPolicy("", { models: MODELS }), null);
  assert.throws(() => policy([{ who: { kind: "user", id: "ou_a" }, models: ["Nope"] }]), /不是这个服务端提供的模型/);
  assert.throws(() => policy([{ who: { kind: "team" }, models: ["GLM-5.3"] }]), /user \/ chat \/ everyone/);
  assert.throws(() => policy([{ who: { kind: "user", id: "oc_a" }, models: ["GLM-5.3"] }]), /open_id/);
  assert.throws(() => policy([{ who: { kind: "chat", id: "ou_a" }, models: ["GLM-5.3"] }]), /群 id/);
  assert.throws(() => policy([{ who: { kind: "everyone" }, models: [] }]), /没有列出任何模型/);
  assert.throws(() => policy({ nope: 1 }), /应当是一组规则/);
  // The JSON a deployment file would hold, as text.
  assert.equal(policy('[{"who":{"kind":"everyone"},"models":["GLM-5.3"]}]').length, 1);
});

test("the most specific rule wins outright, and rules are never merged", async () => {
  const rules = policy([
    { who: { kind: "everyone" }, models: ["MiniMax-M3"] },
    { who: { kind: "chat", id: "oc_team" }, models: ["MiniMax-M3", "GLM-5.3"] },
    { who: { kind: "user", id: "ou_lead" }, models: ["Kimi-K2"] },
  ]);
  const inChat = async (chatId, userId) => chatId === "oc_team" && userId !== "ou_outsider";
  const visibility = new ModelVisibility({ rules, models: MODELS, inChat });

  // user beats chat beats everyone, whatever order they are written in.
  assert.deepEqual(await visibility.visible({ userId: "ou_lead" }), ["Kimi-K2"]);
  assert.deepEqual(await visibility.visible({ userId: "ou_member" }), ["MiniMax-M3", "GLM-5.3"]);
  assert.deepEqual(await visibility.visible({ userId: "ou_outsider" }), ["MiniMax-M3"]);
  // A merged answer would have given the lead all three; that is the reading
  // nobody can hold in their head, so it is not what happens.
  assert.equal((await visibility.visible({ userId: "ou_lead" })).includes("MiniMax-M3"), false);
  // Kept in the server's order, not the rule's: which, not which first.
  const backwards = new ModelVisibility({ models: MODELS, inChat,
    rules: policy([{ who: { kind: "everyone" }, models: ["Kimi-K2", "MiniMax-M3"] }]) });
  assert.deepEqual(await backwards.visible({ userId: "ou_any" }), ["MiniMax-M3", "Kimi-K2"]);
});

test("with no rules nothing is restricted, and the code path is the old one", async () => {
  const off = new ModelVisibility({ models: MODELS });
  assert.equal(off.enabled, false);
  assert.equal(await off.visible({ userId: "ou_a" }), null);
  assert.equal(await off.allows({ userId: "ou_a" }, "GLM-5.3"), true);
  assert.equal(await off.allows({ userId: "ou_a" }, "anything-at-all"), true);
});

test("unmatched is the deployment's decision, and the default is everything", async () => {
  const rules = policy([{ who: { kind: "user", id: "ou_lead" }, models: ["Kimi-K2"] }]);
  // A release that quietly left everybody with no model would be an outage
  // dressed as a security improvement.
  const open = new ModelVisibility({ rules, models: MODELS });
  assert.deepEqual(await open.visible({ userId: "ou_other" }), MODELS);
  const shut = new ModelVisibility({ rules, models: MODELS, defaultVisible: "none" });
  assert.deepEqual(await shut.visible({ userId: "ou_other" }), []);
  assert.throws(() => new ModelVisibility({ rules, models: MODELS, defaultVisible: "maybe" }), /all 或 none/);
});

test("a group that cannot be read does not match, and does not invent an answer", async () => {
  const said = [];
  const rules = policy([
    { who: { kind: "chat", id: "oc_team" }, models: ["Kimi-K2"] },
    { who: { kind: "everyone" }, models: ["MiniMax-M3"] },
  ]);
  const visibility = new ModelVisibility({ rules, models: MODELS, log: (m) => said.push(m),
    inChat: async () => { throw new Error("机器人不在这个群里"); } });
  // The person falls through to the next rule, so what happens when Feishu is
  // unreachable is what the deployment already said happens to somebody
  // unlisted -- not a separate answer invented here.
  assert.deepEqual(await visibility.visible({ userId: "ou_member" }), ["MiniMax-M3"]);
  assert.equal(said.length, 1);
  assert.match(said[0], /读不到群 oc_team/);
});

test("group membership is asked once a minute, and a refusal is held just as long", async () => {
  let clock = 1000, reads = 0, fail = false;
  const membership = chatMembership({ now: () => clock,
    readChatMembers: async () => { reads += 1; if (fail) throw new Error("down"); return ["ou_a", "ou_b"]; } });
  assert.equal(await membership.has("oc_x", "ou_a"), true);
  assert.equal(await membership.has("oc_x", "ou_z"), false);
  assert.equal(reads, 1);
  // Two at once ask once.
  clock += VISIBILITY_LIMITS.cacheMs + 1;
  await Promise.all([membership.has("oc_x", "ou_a"), membership.has("oc_x", "ou_b")]);
  assert.equal(reads, 2);
  // A different group is a different question.
  await membership.has("oc_y", "ou_a");
  assert.equal(reads, 3);
  // An upstream saying no is not asked on every request either.
  clock += VISIBILITY_LIMITS.cacheMs + 1; fail = true;
  await assert.rejects(() => membership.has("oc_x", "ou_a"), /down/);
  await assert.rejects(() => membership.has("oc_x", "ou_a"), /down/);
  assert.equal(reads, 4);
});
