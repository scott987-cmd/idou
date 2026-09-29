import { CREATABLE } from "./schedule-spec.js";
import { makeScheduleCapability, scheduleCapabilityView } from "./schedule-capability.js";
import { MAX_DELIVERIES, deliveryRequests, scheduleDeliveries } from "./schedule-deliveries.js";
import { pushRefusal } from "./schedule-push.js";
import { DOCUMENT_APPEND, MESSAGE_SEND } from "../providers/feishu/cli-write-contract.js";

// The desktop's way in to its own scheduled tasks: list them, create one, pause
// or resume one, delete one, and read what happened when they ran.
//
// Shaped after the other control-plane services rather than invented: the same
// route allowlist, the same refusal of a browser Origin, the same Bearer check
// against a live session, the same body cap. What is different is that this one
// changes a person's own data, so every call is scoped by tenant *and* owner --
// a session can only ever reach the schedules it created.
const ROUTES = Object.freeze({
  list: "/v1/schedules",
  create: "/v1/schedules/create",
  resources: "/v1/schedules/resources",
  update: "/v1/schedules/update",
  runNow: "/v1/schedules/run-now",
  state: "/v1/schedules/state",
  remove: "/v1/schedules/delete",
  runs: "/v1/schedules/runs",
  // One run record at a time: 归档 / 取消归档, and 删除.
  shelveRun: "/v1/schedules/runs/shelve",
  deleteRun: "/v1/schedules/runs/delete",
  // The identity an unattended run acts as. Separate routes because granting it
  // is a decision the person makes, not a side effect of creating a schedule.
  authorize: "/v1/schedules/authorize",
  revoke: "/v1/schedules/revoke",
  consent: "/v1/schedules/consent",
  // The stronger consent: runs while the person is away, for a fixed window,
  // backed by a credential the control plane keeps. Its own routes because it is
  // its own decision -- not a longer version of the one above.
  unattended: "/v1/schedules/unattended",
  unattendedAuthorize: "/v1/schedules/unattended/authorize",
  unattendedAuthorizeStatus: "/v1/schedules/unattended/authorize/status",
  unattendedRevoke: "/v1/schedules/unattended/revoke",
  // 测试通知 in 设置 (G9), pressed by the person.
  notifyTest: "/v1/schedules/notify/test",
});
// A test notification is a real message; pressing twice in a row sends one.
const NOTIFY_TEST_GAP_MS = 10_000;
// A route whose handler cannot share its name. Was one special case inline;
// a second one is a table.
const METHODS = Object.freeze({ consent: "consentStatus", unattended: "unattendedStatus" });
// A 4,000-character Chinese prompt is up to 12KB before JSON metadata.
const MAX_BODY = 32 * 1024;

class ScheduleError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function readJson(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new ScheduleError(415, "json_required");
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new ScheduleError(413, "request_too_large");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new ScheduleError(400, "invalid_json"); }
}

const id = (value) => (typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null);

// What a person is told when Feishu would not resolve a resource -- or, for a
// document the results are to be written into, would not let them edit it.
const RESOURCE_REFUSALS = Object.freeze({
  schedule_wiki_resource_unsupported: "这个 Wiki 节点指向的不是可读取的文档、电子表格或多维表格，暂不能加入定时任务",
  // A proven "no": the resource is there and this person may not read it.
  schedule_resource_access_denied: "当前飞书账号没有这份资源的读取权限：请让所有者分享给你，或重新选择",
  // Feishu refused because of the resource: a link that is mistyped, a
  // resource since deleted, or one outside what this account can see.
  // Feishu does not say which, so neither does this.
  schedule_resource_unreadable: "找不到这份资源，或它不在当前飞书账号能看到的范围内：请检查链接是否完整、资源是否已被删除",
  // Feishu refused to be asked at all. Both scopes are named at once so
  // one visit to the console fixes both, not one per failed attempt.
  schedule_resource_probe_unavailable: "无法向飞书核实这份资源：应用或当前登录缺少所需权限（Wiki 链接需要 wiki:wiki:readonly，读取权限核验需要 docs:permission.member:auth）。请联系管理员在开放平台开通，然后重新登录",
  schedule_resource_resolution_busy: "飞书资源核验繁忙，请稍后重试",
  // What is left once every refusal Feishu names has its own message: the
  // network, Feishu itself, or a login that is no longer valid.
  schedule_resource_resolution_unavailable: "暂时无法向飞书核验资源，请稍后重试；如果一直失败，请重新登录飞书",
  invalid_schedule_resources: "定时任务资源无效",
});

function resourceRefusal(error, { editing = false } = {}) {
  const said = editing && error?.message === "schedule_resource_access_denied"
    ? "当前飞书账号不能编辑这份文档：请让所有者给你编辑权限，或换一份文档"
    : RESOURCE_REFUSALS[error?.message] ?? "定时任务资源核验失败";
  return new ScheduleError(Number.isInteger(error?.status) ? error.status : 400, said);
}

export class ScheduleService {
  // `grants` starts and reads a dedicated Feishu authorization for the
  // unattended credential ({ begin(who, redeemed), status(who, flowId) }, from
  // FeishuLoginService). Without it there is no way to obtain one.
  // `push` is what delivers a finished task's result (SchedulePush); here it
  // only sends a person's 测试通知 to that person.
  constructor({ sessions, store, scheduler = null, consent = null, allowDevelopment = false, unattended = null, grants = null, feishu = null, resourceResolver = null, push = null, now = Date.now }) {
    if (!sessions || !store) throw new Error("Schedule service requires sessions and a store");
    Object.assign(this, { sessions, store, scheduler, consent, allowDevelopment, unattended, grants, feishu, resourceResolver, push, now });
  }

  #tested = new Map();

  // To the caller -- the verified session, on its own token -- and nobody the
  // body names, since nothing in the body is read. An answer either way, with
  // `as` saying which way it went: a test that did not go is the thing the
  // person pressed the button to learn.
  async notifyTest(who, body, token) {
    if (!this.push) throw new ScheduleError(503, "服务端没有开启飞书消息推送");
    const at = this.now(), key = `${who.tenantId}\n${who.userId}`;
    for (const [someone, sentAt] of this.#tested) if (at - sentAt >= NOTIFY_TEST_GAP_MS) this.#tested.delete(someone);
    if (this.#tested.has(key)) throw new ScheduleError(429, "测试通知刚发过，请稍等几秒再试");
    this.#tested.set(key, at);
    const result = await this.push.test({ who, parentToken: token });
    return result.sent ? { sent: true, as: result.as } : { sent: false, reason: result.reason, message: pushRefusal(result.reason) };
  }

  // The person hands the control plane an identity for their unattended runs.
  // Taken from the request's own Bearer rather than from the body: a token in a
  // body is a token in a log, and the one that authorises this is by definition
  // the one already presented.
  async authorize(who, body, token) {
    if (!this.consent) throw new ScheduleError(503, "consent_not_available");
    const granted = this.consent.grant(token);
    // Anything suspended because there was no identity can run again.
    const revived = await this.store.resume(who);
    this.scheduler?.start();
    return { authorized: true, expiresAt: granted.expiresAt, resumed: revived };
  }

  async revoke(who) {
    if (!this.consent) throw new ScheduleError(503, "consent_not_available");
    return { authorized: false, revoked: this.consent.revoke(who) };
  }

  async consentStatus(who) {
    if (!this.consent) return { authorized: false, expiresAt: null };
    return this.consent.status(who);
  }

  // Not a 503 when the feature is off: the desktop asks this to decide whether
  // to offer the choice at all, and an error would make it show a button that
  // can only fail.
  async unattendedStatus(who) {
    if (!this.unattended) return { available: false, authorized: false, windowDays: 0, expiresAt: null, state: null, reason: null, lastUsedAt: null };
    return this.unattended.status(who);
  }

  // Starts the dedicated authorization. Its result arrives at the control plane,
  // not here: the desktop opens the launch URL and then asks the status route.
  // The credential is stored by the callback below, and only for this person.
  async unattendedAuthorize(who) {
    if (!this.unattended || !this.grants) throw new ScheduleError(503, "unattended_not_available");
    const begun = this.#grant(() => this.grants.begin(who, async (redeemed) => {
      if (redeemed.tenantId !== who.tenantId || redeemed.userId !== who.userId) throw new Error("authorization_for_someone_else");
      const granted = await this.unattended.grantRedeemed(redeemed);
      // Anything suspended because there was no identity can run again.
      const resumed = await this.store.resume(who);
      this.scheduler?.start();
      return { expiresAt: granted.expiresAt, resumed };
    }));
    return { pending: true, flowId: begun.flowId, launchUrl: begun.launchUrl, expiresAt: begun.expiresAt };
  }

  async unattendedAuthorizeStatus(who, body) {
    if (!this.unattended || !this.grants) throw new ScheduleError(503, "unattended_not_available");
    const seen = this.#grant(() => this.grants.status(who, body?.flowId));
    if (seen.status !== "granted") return { status: seen.status, ...(seen.status === "pending" ? { expiresAt: seen.expiresAt } : {}) };
    return { status: "granted", authorized: true, expiresAt: seen.expiresAt, resumed: seen.resumed ?? 0 };
  }

  // The login service's refusals carry an HTTP status and a fixed code.
  #grant(operation) {
    try { return operation(); }
    catch (error) { throw new ScheduleError(Number.isInteger(error?.status) ? error.status : 400, error?.message ?? "grant_failed"); }
  }

  // Deliberately does not resume anything: taking an authorization back should
  // not be a way to start tasks running again.
  async unattendedRevoke(who) {
    if (!this.unattended) throw new ScheduleError(503, "unattended_not_available");
    return { authorized: false, revoked: await this.unattended.revoke(who) };
  }

  // The same gate every other service here uses. A verified Feishu login is
  // required outside development, because a schedule acts as that person later,
  // when they are not there to be asked.
  #token(req) {
    const header = req.headers.authorization;
    return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  }

  #who(req) {
    const token = this.#token(req);
    const who = this.sessions.verify(token);
    if (!who) throw new ScheduleError(401, "session_expired_or_invalid");
    if (who.authProvider !== "feishu" && !this.allowDevelopment) throw new ScheduleError(403, "verified_login_required");
    if (who.audience !== "codex-model-gateway") throw new ScheduleError(403, "scope_required");
    return who;
  }

  async handle(req, res) {
    const route = Object.entries(ROUTES).find(([, path]) => req.url === path)?.[0];
    if (!route) return false;
    try {
      // Called by the native client, never a page: an Origin header means
      // something else is asking.
      if (req.headers.origin) throw new ScheduleError(403, "browser_origin_not_allowed");
      if (req.method !== "POST") throw new ScheduleError(405, "method_not_allowed");
      this.sessions.prune?.();
      const who = this.#who(req);
      const body = await readJson(req);
      // Re-checked after reading the body: a session that lapsed while the
      // request was in flight must not still be acted on.
      this.#who(req);
      const method = METHODS[route] ?? route;
      this.#send(res, 200, await this[method](who, body, this.#token(req)));
    } catch (error) {
      req.resume();
      const status = error instanceof ScheduleError ? error.status : 400;
      this.#send(res, status, { error: error?.message ?? "schedule_request_failed" });
    }
    return true;
  }

  #send(res, status, value) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  }

  // Only this person's own schedules -- the store is keyed by tenant, and the
  // owner narrows it to the one who created them. Asked of the store, so a
  // tenant's other tasks are not read to be thrown away; checked here again.
  async #mine(who) { return (await this.store.list(who, { mine: true })).filter((row) => row.owner === who.userId); }

  async list(who, body) {
    const all = await this.#mine(who);
    const state = body?.state;
    const rows = state === "active" || state === "paused" ? all.filter((row) => row.state === state) : all;
    // Each row's newest run, so the list can say 运行中 and group by it (G13, G14).
    const latest = await this.store.latestRuns(who);
    // `rules` is what this server will create, so a desktop newer or older than
    // it offers exactly those in its dialog rather than a choice that is refused.
    // `deliveries` likewise says where this server can write a task's results
    // (schedule-deliveries.js): without it a desktop shows no such choice.
    const kinds = this.#deliveryKinds(who);
    return { schedules: rows.map((row) => ({ ...this.#view(row), lastRun: this.#lastRun(latest.get(row.id)) })), limit: this.store.limits.perUser, rules: CREATABLE,
      ...(kinds.length ? { deliveries: { max: MAX_DELIVERIES, kinds } } : {}) };
  }

  #lastRun(run) {
    return run ? { id: run.id, startedAt: run.startedAt, finishedAt: run.finishedAt, outcome: run.outcome, kind: run.kind } : null;
  }

  async create(who, body, token) {
    const resources = await this.#resolveResources(body?.resources ?? [], token);
    const deliveries = (await this.#resolveDeliveries(who, body?.deliveries, token)) ?? [];
    const capabilityBinding = this.feishu
      ? makeScheduleCapability({ feishu: this.feishu, who, resources, validUntil: body?.endAt ?? null })
      : undefined;
    const created = await this.store.create(who, { ...body, resources, deliveries, capabilityBinding });
    // A new schedule may be due sooner than whatever the scheduler is currently
    // sleeping until, so the clock is re-armed rather than left to wake late.
    this.scheduler?.start();
    return { schedule: this.#view(created) };
  }

  async #resolveResources(input, token) {
    let resources = input;
    // Anything that arrives as a link is resolved and proven readable first --
    // documents, spreadsheets and Bases alike. Only chats, which are named by id
    // and checked at run time, pass straight through.
    if (resources.some(row => ["document", "sheet", "base"].includes(row?.kind)) && this.resourceResolver?.resolveScheduleResources) {
      try { resources = await this.resourceResolver.resolveScheduleResources(token, resources); }
      catch (error) { throw resourceRefusal(error); }
    }
    return resources;
  }

  // Which kinds of place this server can write a person's task results to: a
  // document where the deployment lets them append to one through the bridge,
  // a chat where it lets them send -- the same two things a run's delivery
  // checks again (schedule-delivery.js). Nothing without Feishu.
  #deliveryKinds(who) {
    const access = this.resourceResolver;
    if (!this.feishu || typeof access?.resolveScheduleResources !== "function" || access.scheduleResourcesEnabled !== true || who?.cliBridge !== true) return [];
    const actions = Array.isArray(access.cliWriteActions) ? access.cliWriteActions : [];
    return [actions.includes(DOCUMENT_APPEND) && who.cliDocumentWrites === true && "document",
      actions.includes(MESSAGE_SEND) && who.cliMessageWrites === true && "chat"].filter(Boolean);
  }

  // Where a task's results go besides its owner (schedule-deliveries.js),
  // resolved as the person choosing them: a document by its link, proven
  // editable by them now; a chat by its id -- the send itself is made as them,
  // so Feishu refuses one they are not in. `undefined` for a request that did
  // not say, which an edit takes as "keep what the task has".
  async #resolveDeliveries(who, input, token) {
    if (input === undefined) return undefined;
    let requests;
    try { requests = deliveryRequests(input); } catch (error) { throw new ScheduleError(400, error?.message ?? "结果写到的地方无效"); }
    if (!requests.length) return [];
    const kinds = this.#deliveryKinds(who);
    if (requests.some((row) => row.kind === "document") && !kinds.includes("document")) throw new ScheduleError(400, "这个服务端或你的登录没有开启飞书文档写入，结果不能追加到文档");
    if (requests.some((row) => row.kind === "chat") && !kinds.includes("chat")) throw new ScheduleError(400, "这个服务端或你的登录没有开启飞书发消息，结果不能发到会话");
    const documents = requests.filter((row) => row.kind === "document");
    let resolved = [];
    if (documents.length) {
      try { resolved = await this.resourceResolver.resolveScheduleResources(token, documents.map((row) => ({ kind: "document", reference: row.reference, ...(row.label ? { label: row.label } : {}) })), { action: "edit" }); }
      catch (error) { throw resourceRefusal(error, { editing: true }); }
    }
    const rows = [];
    for (const row of resolved) {
      if (row.kind !== "document") throw new ScheduleError(400, "结果只能追加到文档：这个链接指向的不是文档");
      rows.push({ kind: "document", id: this.feishu.references.document(row.reference).token, reference: row.reference, label: row.label });
    }
    for (const row of requests.filter((item) => item.kind === "chat")) rows.push({ kind: "chat", id: row.id, label: row.label });
    try { return scheduleDeliveries(rows); } catch (error) { throw new ScheduleError(400, error?.message ?? "结果写到的地方无效"); }
  }

  async resources(who, body, token) {
    const target = id(body?.id);
    if (!target || !Array.isArray(body?.resources) || !Number.isSafeInteger(body?.expectedRevision) || body.expectedRevision < 1) {
      throw new ScheduleError(400, "定时任务资源无效");
    }
    const current = await this.store.get(who, target);
    if (!current || current.owner !== who.userId) throw new ScheduleError(404, "not_found");
    if (!current.capability || !Number.isSafeInteger(current.capabilityRevision)) throw new ScheduleError(409, "旧任务没有可换版的资源授权，请重新创建");
    if (current.capabilityRevision !== body.expectedRevision) throw new ScheduleError(409, "资源授权已经变化，请刷新后重试");
    const resources = await this.#resolveResources(body.resources, token);
    let capabilityBinding;
    try { capabilityBinding = makeScheduleCapability({ feishu: this.feishu, who, resources, validUntil: current.endAt, revision: current.capabilityRevision + 1 }); }
    catch (error) { throw new ScheduleError(400, error?.message ?? "定时任务资源无效"); }
    let updated;
    try { updated = await this.store.updateCapability(who, target, capabilityBinding, current.capabilityRevision); }
    catch (error) { throw new ScheduleError(/已经变化/u.test(error?.message ?? "") ? 409 : 400, error?.message ?? "资源授权更新失败"); }
    this.scheduler?.cancel?.(who.tenantId, target);
    this.scheduler?.start();
    return { schedule: this.#view(updated) };
  }

  // Editing what a task is, never what it may read (that is `resources`). The
  // version edited against travels with the edit, so an older window refuses
  // rather than overwrites.
  async update(who, body, token) {
    const target = id(body?.id);
    if (!target || !Number.isSafeInteger(body?.expectedUpdatedAt)) throw new ScheduleError(400, "定时任务无效");
    const before = await this.store.get(who, target);
    if (!before || before.owner !== who.userId) throw new ScheduleError(404, "not_found");
    // Where the results go is resolved and proven again only when the edit says;
    // an edit from a desktop that does not know of it keeps what the task has.
    const deliveries = await this.#resolveDeliveries(who, body?.deliveries, token);
    let updated;
    try { updated = await this.store.updateDefinition(who, target, { ...body, deliveries }, body.expectedUpdatedAt); }
    catch (error) { throw new ScheduleError(/已经变化/u.test(error?.message ?? "") ? 409 : 400, error?.message ?? "定时任务修改失败"); }
    // A new end date renewed the grant, which cancels a run holding the old one.
    if (updated.capabilityRevision !== before.capabilityRevision) this.scheduler?.cancel?.(who.tenantId, target);
    this.scheduler?.start();
    return { schedule: this.#view(updated) };
  }

  // One run now, outside the rule, through the same path as a due one. A
  // development server manages schedules but does not execute them, and says so.
  async runNow(who, body) {
    const target = id(body?.id);
    if (!target) throw new ScheduleError(400, "invalid_schedule_id");
    const row = await this.store.get(who, target);
    if (!row || row.owner !== who.userId) throw new ScheduleError(404, "not_found");
    if (typeof this.scheduler?.runNow !== "function") throw new ScheduleError(503, "当前服务端只管理定时任务，不执行");
    try { return { run: await this.scheduler.runNow(row) }; }
    catch (error) { throw new ScheduleError(Number.isInteger(error?.status) ? error.status : 400, error?.message ?? "这次没有运行"); }
  }

  async state(who, body) {
    const target = id(body?.id);
    if (!target) throw new ScheduleError(400, "invalid_schedule_id");
    if (!(await this.#owned(who, target))) throw new ScheduleError(404, "not_found");
    const updated = await this.store.setState(who, target, body?.state);
    if (body?.state === "paused") this.scheduler?.cancel?.(who.tenantId, target);
    this.scheduler?.start();
    return { schedule: this.#view(updated) };
  }

  async remove(who, body) {
    const target = id(body?.id);
    if (!target) throw new ScheduleError(400, "invalid_schedule_id");
    if (!(await this.#owned(who, target))) throw new ScheduleError(404, "not_found");
    const removed = await this.store.remove(who, target);
    if (removed) this.scheduler?.cancel?.(who.tenantId, target);
    this.scheduler?.start();
    return { removed };
  }

  async runs(who, body) {
    const target = id(body?.id);
    // No id means the 运行记录 view: every run this person's schedules made,
    // newest first, rather than one schedule's history -- narrowed, when asked,
    // to one of the view's filters.
    // The store chooses the person's own runs by the run's own owner, so a run
    // whose task was deleted is still theirs, and still listed (G11).
    if (!target) return { runs: (await this.store.recentRuns(who, body?.limit, body?.filter ?? "")).map((run) => this.#runView(run)) };
    if (!(await this.#owned(who, target))) throw new ScheduleError(404, "not_found");
    // One task's own history, with the same filters as 运行记录 (G12).
    return { runs: (await this.store.recentRuns(who, body?.limit, body?.filter ?? "", target)).map((run) => this.#runView(run)) };
  }

  // A record keeps what was written. A report linked before 2026-09-29 was
  // linked in a form Feishu answers with its 404 page (drive-files.js), so it
  // is shown with the link the deployment opens for that file -- the button and
  // the sentence alike.
  #runView(run) {
    const url = run?.artifact?.url;
    const fixed = typeof url === "string" && this.feishu?.repairedLink ? this.feishu.repairedLink(url) : url;
    if (fixed === url) return run;
    return { ...run, artifact: { ...run.artifact, url: fixed }, ...(typeof run.detail === "string" ? { detail: run.detail.split(url).join(fixed) } : {}) };
  }

  // The wording is WorkBuddy's, where these two actions come from. What the
  // store refuses -- someone else's run, one that is gone -- is the same 404,
  // so a guessed id learns nothing about anybody else's history.
  async #finishedRun(who, body, verb) {
    const target = id(body?.runId);
    if (!target) throw new ScheduleError(400, "运行记录无效");
    const run = await this.store.getRun(who, target);
    if (!run) throw new ScheduleError(404, "找不到这条运行记录，它可能已被删除");
    if (!Number.isSafeInteger(run.finishedAt)) throw new ScheduleError(409, `任务进行中，无法${verb}`);
    return target;
  }

  async shelveRun(who, body) {
    if (typeof body?.shelved !== "boolean") throw new ScheduleError(400, "运行记录无效");
    const target = await this.#finishedRun(who, body, body.shelved ? "归档" : "取消归档");
    const run = await this.store.shelveRun(who, target, body.shelved);
    if (!run) throw new ScheduleError(404, "找不到这条运行记录，它可能已被删除");
    return { run: this.#runView(run) };
  }

  async deleteRun(who, body) {
    const target = await this.#finishedRun(who, body, "删除");
    if (!(await this.store.deleteRun(who, target))) throw new ScheduleError(404, "找不到这条运行记录，它可能已被删除");
    return { removed: true };
  }

  // Another person in the same tenant must not be able to pause, delete or read
  // a schedule they did not create -- the store's tenant key alone would let
  // them.
  async #owned(who, target) {
    const row = await this.store.get(who, target);
    return Boolean(row) && row.owner === who.userId;
  }

  // What the desktop shows. The prompt is included because the list is also the
  // edit surface; nothing here carries a token or a credential.
  #view(row) {
    return { id: row.id, title: row.title, prompt: row.prompt, promptExpired: !row.prompt, mode: row.mode, schedule: row.schedule,
      spec: row.spec, ruleSupported: row.ruleSupported, memory: row.memory, state: row.state, suspended: row.suspendedAt !== null, nextAt: row.nextAt, startAt: row.startAt, endAt: row.endAt,
      access: scheduleCapabilityView(row.capability ? { capability: row.capability, revision: row.capabilityRevision } : null),
      deliveries: (row.deliveries ?? []).map((item) => ({ ...item })),
      resourceGrantRequired: !row.capability, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }
}
