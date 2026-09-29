import test from "node:test";
import assert from "node:assert/strict";

const ROUTE = "/v1/sandbox/egress";

// The client reads its egress address and run token from the environment at
// import time, so each case loads a fresh copy with the environment it needs.
async function client({ egress = "http://egress.mydoubao.internal:881", run = "R".repeat(43), reply } = {}) {
  process.env.IDOU_EGRESS = egress ?? "";
  process.env.IDOU_RUN = run ?? "";
  if (egress === null) delete process.env.IDOU_EGRESS;
  if (run === null) delete process.env.IDOU_RUN;
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, headers: options.headers });
    const answer = typeof reply === "function" ? reply(calls.length, options) : reply;
    // `JSON.stringify(undefined)` is `undefined`, not `"undefined"` -- which is
    // exactly how a bodiless response reaches the client, so it is left as is.
    return { ok: (answer.status ?? 200) < 400, status: answer.status ?? 200,
      text: async () => (typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)) };
  };
  const loaded = await import(`../bin/sandbox/feishu.js?case=${calls.length}-${Math.random()}`);
  return { ...loaded, calls, restore: () => { globalThis.fetch = original; } };
}
const ok = (data) => ({ status: 200, body: { code: 0, data } });

test("a read goes to the egress route carrying the run token and no credential", async (t) => {
  const c = await client({ reply: ok({ name: "某人" }) });
  t.after(c.restore);
  assert.deepEqual(await c.read("/open-apis/authen/v1/user_info"), { name: "某人" });
  const [call] = c.calls;
  assert.equal(call.url, `http://egress.mydoubao.internal:881${ROUTE}`);
  assert.equal(call.headers["x-mydoubao-feishu-path"], "/open-apis/authen/v1/user_info");
  assert.equal(call.headers["x-mydoubao-run"], "R".repeat(43));
  assert.ok(!JSON.stringify(call.headers).toLowerCase().includes("authorization"), "the sandbox has nothing to authorize with");
});

test("without an egress address or a run token it refuses rather than trying something else", async (t) => {
  const missing = await client({ egress: null, reply: ok({}) });
  t.after(missing.restore);
  await assert.rejects(() => missing.read("/open-apis/im/v1/chats"), /缺少出口地址或运行令牌/);
  assert.equal(missing.calls.length, 0);

  const noToken = await client({ run: null, reply: ok({}) });
  t.after(noToken.restore);
  await assert.rejects(() => noToken.read("/open-apis/im/v1/chats"), /缺少出口地址或运行令牌/);
});

test("a loopback egress address is refused where it is used, not only where it is built", async (t) => {
  for (const egress of ["http://127.0.0.1:881", "http://localhost:881", "https://[::1]:881"]) {
    const c = await client({ egress, reply: ok({}) });
    t.after(c.restore);
    // Inside a container loopback is the container: a task pointed there would
    // believe it had a way out and quietly talk to itself.
    await assert.rejects(() => c.read("/open-apis/im/v1/chats"), /回环地址/, `${egress} must be refused`);
    assert.equal(c.calls.length, 0);
  }
});

test("only Feishu API paths are sent at all", async (t) => {
  const c = await client({ reply: ok({}) });
  t.after(c.restore);
  for (const path of ["", "/etc/passwd", "https://evil.example.com/open-apis/x", "open-apis/im/v1/chats", "/v1/sandbox/egress"]) {
    await assert.rejects(() => c.read(path), /不是有效的飞书接口路径/, `${JSON.stringify(path)} must be refused`);
  }
  assert.equal(c.calls.length, 0);
});

test("the proxy refusing and Feishu refusing are different failures", async (t) => {
  // They point at different causes -- one means the sandbox asked for something
  // it may not have, the other means Feishu said no -- so a task that reports
  // them identically sends someone looking in the wrong place.
  const refused = await client({ reply: { status: 405, body: { error: "sandbox_egress_read_only" } } });
  t.after(refused.restore);
  await assert.rejects(() => refused.read("/open-apis/im/v1/chats"), (error) =>
    error.status === 405 && error.code === "sandbox_egress_read_only");

  const feishuSaidNo = await client({ reply: { status: 200, body: { code: 99991672, msg: "no permission" } } });
  t.after(feishuSaidNo.restore);
  await assert.rejects(() => feishuSaidNo.read("/open-apis/im/v1/chats"), (error) =>
    error.status === 200 && error.code === "feishu_99991672");

  // A body that is not JSON, and a body that is not there at all, are two
  // different causes and neither may surface as a bare TypeError: unattended,
  // that is what ends up in the run record for a person to read.
  const garbled = await client({ reply: { status: 200, body: "not json at all" } });
  t.after(garbled.restore);
  await assert.rejects(() => garbled.read("/open-apis/im/v1/chats"), (error) =>
    error instanceof garbled.FeishuReadError && error.code === "invalid_json" && error.path === "/open-apis/im/v1/chats");

  const empty = await client({ reply: { status: 204, body: undefined } });
  t.after(empty.restore);
  await assert.rejects(() => empty.read("/open-apis/im/v1/chats"), (error) =>
    error instanceof empty.FeishuReadError && error.code === "empty_response" && error.status === 204);
});

test("paging follows the cursor and stops where Feishu stops", async (t) => {
  const c = await client({ reply: (n) => n === 1
    ? ok({ items: [{ id: "a" }], has_more: true, page_token: "next-1" })
    : ok({ items: [{ id: "b" }], has_more: false }) });
  t.after(c.restore);
  const result = await c.readAll("/open-apis/im/v1/chats?page_size=50");
  assert.deepEqual(result.items.map((row) => row.id), ["a", "b"]);
  assert.equal(result.complete, true);
  assert.match(c.calls[1].headers["x-mydoubao-feishu-path"], /page_token=next-1/);
  assert.match(c.calls[1].headers["x-mydoubao-feishu-path"], /page_size=50&page_token=/, "the cursor is appended, not substituted");
});

test("a list too long to finish says so instead of passing a fragment off as the whole", async (t) => {
  // Unbounded, one call would spend a scheduled task's entire budget with
  // nobody watching -- and a truncated list reported as complete is worse than
  // a slow one, because the summary built from it would be quietly wrong.
  const c = await client({ reply: (n) => ok({ items: [{ id: n }], has_more: true, page_token: `p${n}` }) });
  t.after(c.restore);
  const result = await c.readAll("/open-apis/im/v1/chats", { maxPages: 3 });
  assert.equal(result.items.length, 3);
  assert.equal(result.complete, false, "the caller is told the list was cut short");
  assert.equal(c.calls.length, 3, "and it stopped at the bound");
});
