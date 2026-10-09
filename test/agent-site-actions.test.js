// Publishing a site from a conversation (docs/sites-phase1.md §1.1): the Agent
// asks through the same card as 文档网站's 发布, or on 完全访问 without one,
// and only for a folder of its own task with a page in it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentSiteActions } from "../src/application/agent-site-actions.js";
import { sitePublishCard } from "../src/application/site-publishing.js";

async function setting(t, permission) {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-agent-site-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "task"), outside = path.join(root, "elsewhere");
  await mkdir(path.join(cwd, "site"), { recursive: true }); await mkdir(outside);
  await writeFile(path.join(cwd, "index.html"), "<!doctype html><h1>看板</h1>");
  await writeFile(path.join(cwd, "site", "index.html"), "<!doctype html><h1>子目录</h1>");
  await writeFile(path.join(outside, "index.html"), "<!doctype html><h1>别处</h1>");
  await mkdir(path.join(cwd, "empty"));
  const task = { id: "t1", title: "销售看板", cwd, permission };
  const cards = [], published = [];
  const sites = {
    publishFolder: async ({ folder, name, scope, approve, task: asked }) => {
      await approve(sitePublishCard({ name: name ?? asked.title, files: 1, bytes: 30, share: { scope: scope ?? "invited" } }));
      published.push({ folder, name, scope });
      return { url: "https://sites.example/s/x/", offline: false };
    },
    list: async () => [{ name: "销售看板", url: "https://sites.example/s/x/" }],
  };
  const answer = { response: 0, reason: "answered" };
  const actions = agentSiteActions({ getScope: () => ({ service: { get: () => task } }), confirm: async (card) => { cards.push(card); return answer; }, sites });
  return { actions, cards, published, answer, cwd, outside };
}

test("from a standard task the site is published only after the person's card; declined, nothing goes out", async (t) => {
  const { actions, cards, published, answer, cwd } = await setting(t, "standard");
  await assert.rejects(actions["site-publish"]({ dir: ".", scope: "tenant" }, "t1"), /用户没有发布这个网站：什么都没有发出去/);
  assert.deepEqual([cards.length, published.length], [1, 0]);
  assert.equal(cards[0].title, "确认发布这个网站");
  assert.equal(cards[0].taskId, "t1", "the card belongs to the conversation that asked");
  assert.match(cards[0].detail, /谁能打开：组织内获得链接的人可阅读/);
  answer.response = 1;
  assert.deepEqual(await actions["site-publish"]({ dir: "site", name: "子站" }, "t1"), { url: "https://sites.example/s/x/", offline: false });
  assert.deepEqual(published, [{ folder: path.join(await (await import("node:fs/promises")).realpath(cwd), "site"), name: "子站", scope: null }]);
  // A card that lapsed is said as such: the Agent must not ask again by itself.
  answer.response = 0; answer.reason = "timeout";
  await assert.rejects(actions["site-publish"]({}, "t1"), /5 分钟没有回应/);
});

test("from a task on full access it is published without a card", async (t) => {
  const { actions, cards, published } = await setting(t, "full");
  await actions["site-publish"]({ dir: "." }, "t1");
  assert.deepEqual([cards.length, published.length], [0, 1]);
});

test("only a folder of the task's own with a page in it, and only the scopes there are", async (t) => {
  const { actions, published, outside } = await setting(t, "full");
  await assert.rejects(actions["site-publish"]({ dir: outside }, "t1"), /必须在当前任务的文件夹里/);
  await assert.rejects(actions["site-publish"]({ dir: "../elsewhere" }, "t1"), /必须在当前任务的文件夹里/);
  await assert.rejects(actions["site-publish"]({ dir: "empty" }, "t1"), /没有 index.html/);
  await assert.rejects(actions["site-publish"]({ dir: "missing" }, "t1"), /找不到这个网站目录/);
  await assert.rejects(actions["site-publish"]({ scope: "everyone" }, "t1"), /--scope 只能是/);
  await assert.rejects(actions["site-publish"]({ name: "x".repeat(81) }, "t1"), /--name/);
  assert.equal(published.length, 0);
  assert.deepEqual(await actions["site-list"]({}, "t1"), [{ name: "销售看板", url: "https://sites.example/s/x/" }]);
});
