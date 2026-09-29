// The desktop's side of scheduled tasks. Shaped after the other control-plane
// clients here rather than invented: POST, the session's own bearer, a timeout,
// a cap on how much of a response is read, and a refusal to treat anything that
// is not JSON as a result.
//
// One thing it deliberately does not do is retry. A create that timed out may
// well have been recorded, and a second attempt would give the person two
// schedules where they asked for one -- so a broken connection is reported as an
// unknown outcome and the list is what settles it. The one exception is a
// session the server does not know: it refuses that before doing anything, so
// the same request is sent once more after signing back in (`recover`).
import { SESSION_UNKNOWN } from "./desktop-auth.js";

const MAX_RESPONSE = 256 * 1024;
const SIGNED_OUT = "登录已失效：服务端不认这次登录了（多半是服务端刚重启过），自动重连还没有成功。可以稍后再试；一直这样的话，请到「设置 → 飞书账号」重新登录。";
const OLDER_SERVER = "服务端版本较旧，还不支持归档或删除单条运行记录。请升级并重启服务端后再试。";
const OLDER_NOTIFY = "服务端没有启用定时任务，或版本较旧、还不支持测试通知。";

export class ScheduleHttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class ScheduleClient {
  // `recover(token)` signs back in when the server refuses `token` as a session
  // it does not know (DesktopAuth.recover); true once connected again.
  constructor({ session, recover = null, fetchImpl = fetch, timeoutMs = 15_000 }) {
    if (typeof session !== "function") throw new Error("Schedule client needs a session source");
    Object.assign(this, { session, recover, fetch: fetchImpl, timeoutMs });
  }

  async #request(route, body = {}, options = {}) {
    const current = await this.session();
    try { return await this.#send(current, route, body, options); } catch (error) {
      if (!(error instanceof ScheduleHttpError) || error.status !== 401 || error.message !== SESSION_UNKNOWN) throw error;
      if (!await this.recover?.(current.token).catch(() => false)) throw new ScheduleHttpError(401, SIGNED_OUT);
    }
    try { return await this.#send(await this.session(), route, body, options); } catch (error) {
      if (error instanceof ScheduleHttpError && error.status === 401 && error.message === SESSION_UNKNOWN) throw new ScheduleHttpError(401, SIGNED_OUT);
      throw error;
    }
  }

  // `missing` is what a 404 means for a route newer than the list: the server
  // has scheduled tasks, it is just older than this desktop -- which is not the
  // same as "turned off", and saying so would send someone to the wrong setting.
  async #send(current, route, body, { missing = null } = {}) {
    if (!current?.token || !current?.serverUrl) throw new Error("还没有连接到服务端，请先登录");
    let response;
    try {
      response = await this.fetch(`${current.serverUrl}${route}`, { method: "POST", redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { authorization: `Bearer ${current.token}`, "content-type": "application/json" },
        body: JSON.stringify(body) });
    } catch { throw new Error("与服务端的连接中断，这次操作的结果未知；请刷新列表确认后再重试"); }

    if (response.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new ScheduleHttpError(response.status, response.status === 404
        ? missing ?? "服务端没有启用定时任务。请在部署文件中加上 IDOU_SCHEDULED_TASKS=1 并重启服务端。"
        : `定时任务服务返回了异常响应（HTTP ${response.status}）`);
    }
    const chunks = []; let size = 0; const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error("定时任务响应超限"); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }

    let value;
    try { value = JSON.parse(Buffer.concat(chunks)); } catch { throw new Error("定时任务服务响应无效"); }
    // The service answers refusals in the person's own words; passing that
    // through beats translating it into an HTTP status they would have to look up.
    if (!response.ok) throw new ScheduleHttpError(response.status, value?.error ?? `定时任务服务拒绝了这次操作（HTTP ${response.status}）`);
    return value;
  }

  list(state) { return this.#request("/v1/schedules", state ? { state } : {}); }
  create(definition) { return this.#request("/v1/schedules/create", definition); }
  updateResources(id, resources, expectedRevision) { return this.#request("/v1/schedules/resources", { id, resources, expectedRevision }); }
  update(id, definition, expectedUpdatedAt) { return this.#request("/v1/schedules/update", { ...definition, id, expectedUpdatedAt }); }
  runNow(id) { return this.#request("/v1/schedules/run-now", { id }); }
  setState(id, state) { return this.#request("/v1/schedules/state", { id, state }); }
  remove(id) { return this.#request("/v1/schedules/delete", { id }); }
  // `filter` narrows the 运行记录 view: completed, failed, running or shelved.
  runs(id, limit, filter) { return this.#request("/v1/schedules/runs", { ...(id ? { id } : {}), limit, ...(filter ? { filter } : {}) }); }
  shelveRun(runId, shelved) { return this.#request("/v1/schedules/runs/shelve", { runId, shelved }, { missing: OLDER_SERVER }); }
  deleteRun(runId) { return this.#request("/v1/schedules/runs/delete", { runId }, { missing: OLDER_SERVER }); }
  // The identity unattended runs act as: handed over explicitly, taken back the
  // same way, and reported so the UI can say plainly whether it is in place.
  authorize() { return this.#request("/v1/schedules/authorize", {}); }
  revoke() { return this.#request("/v1/schedules/revoke", {}); }
  consent() { return this.#request("/v1/schedules/consent", {}); }
  // The stronger one: runs while the person is away, for a fixed window.
  unattended() { return this.#request("/v1/schedules/unattended", {}); }
  // Starts a dedicated Feishu authorization; the result is read with the next one.
  authorizeUnattended() { return this.#request("/v1/schedules/unattended/authorize", {}); }
  unattendedAuthorizeStatus(flowId) { return this.#request("/v1/schedules/unattended/authorize/status", { flowId }); }
  revokeUnattended() { return this.#request("/v1/schedules/unattended/revoke", {}); }
  // 测试通知 in 设置 (G9): one fixed line, sent to you.
  testNotify() { return this.#request("/v1/schedules/notify/test", {}, { missing: OLDER_NOTIFY }); }
}
