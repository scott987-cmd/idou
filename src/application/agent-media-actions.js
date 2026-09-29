import { MEDIA_PROVIDERS, mediaInput } from "./media-workspace.js";
import { declined } from "./agent-confirmation.js";
import { permitsUnattendedActions } from "../permissions.js";

// Image and video generation, requested from the conversation instead of a
// standing panel.
//
// The Agent never reaches the media service itself: the provider key is
// server-side, the lease is minted by the main process from the parent session,
// and the Agent's shell carries no server URL and no token. So these actions do
// exactly what the panel's buttons did -- prepare, ask the person, then submit
// through the same application layer -- and the Agent only ever sees the job
// record that comes back.
//
// From a task on 完全访问 an image, a save to Drive and a stop go without the
// card (permissions.js). A video asks every time, whatever the task: the Token
// Plan it is generated on allows interactive use only.
const CANCELLED = "用户取消了这次操作。";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const jobId = (value) => {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("--job 需要一个媒体记录 id（生成时返回的 id）");
  return value;
};

// What the person is deciding about is the description that will be sent
// upstream and billed, so it is shown in full rather than summarised -- and
// where it goes and what makes it are what the server said in its offer
// (media-workspace.js mediaOffer), not what this build assumes.
export function describeMedia(request, offer) {
  const provider = MEDIA_PROVIDERS[offer.provider];
  return request.kind === "image"
    ? { title: "确认生成图片", message: "生成一张图片", provider, model: `${offer.model} · ${request.aspectRatio}` }
    : { title: "确认生成视频", message: "生成一段视频", provider,
      model: [offer.model, `${offer.seconds} 秒`, offer.resolution, offer.aspectRatio].filter(Boolean).join(" · ") };
}

// The ones that only read or show: they never raise a card, so they are
// answered beside a write that is waiting on one (agent-reads.js).
export const MEDIA_READS = Object.freeze(["media-status", "media-preview", "media-verify", "media-folder"]);

// `changed` is told the task whenever an action may have changed its media
// records, so a 图片与视频 panel on screen follows the Agent instead of showing
// the list it read when it was opened (2026-09-23: a video was submitted,
// polled and finished while the panel still said 4 records).
export function agentMediaActions({ getScope, confirm, openPreview, changed = () => {} }) {
  if (typeof getScope !== "function" || typeof confirm !== "function" || typeof openPreview !== "function") throw new Error("Invalid agent media action wiring");
  // After the action either way: a failed check can still have moved a record.
  const telling = (work) => async (params, taskId) => { try { return await work(params, taskId); } finally { changed(taskId); } };
  const bind = (taskId) => {
    const scope = getScope();
    if (!scope) throw new Error("应用尚未就绪");
    return { scope, task: scope.service.get(taskId) };
  };
  return {
    "media-create": telling(async (params, taskId) => {
      const { scope, task } = bind(taskId);
      // An aspect ratio given for a video is refused rather than dropped: the
      // Agent asked for something specific and would otherwise be told it
      // succeeded while the setting was quietly ignored.
      const request = mediaInput({ kind: params.kind, prompt: params.prompt,
        ...(params.aspect === undefined ? {} : { aspectRatio: params.aspect }) });
      const draft = await scope.media.prepare(taskId, request);
      if (request.kind === "image" && permitsUnattendedActions(task)) return scope.media.create(draft);
      const shown = describeMedia(request, draft.lease.offer);
      const choice = await confirm({ type: "warning", title: shown.title, message: shown.message,
        detail: `任务：${task.title}\n${shown.model}\n服务端：${draft.session.serverUrl}\n\n${request.prompt}`,
        boundary: `描述将发送给企业服务端及${shown.provider}，可能产生模型费用。取消或断线不保证停止上游计费。成果是临时预览，过期即失效；要留存请再确认一次保存到飞书云盘。`,
        buttons: ["取消", shown.message], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) throw declined(choice, CANCELLED);
      // A video is not finished when this returns; the Agent polls media-status.
      return scope.media.create(draft);
    }),
    // Reading a job's state costs nothing and changes nothing, so it needs no
    // confirmation -- unlike every write in this bridge.
    "media-status": telling(async (params, taskId) => {
      const { scope } = bind(taskId);
      return scope.media.refresh(taskId, jobId(params.job));
    }),
    // Stopping a job discards a result that may already have been billed, so it
    // is a decision, not a read.
    "media-cancel": telling(async (params, taskId) => {
      const { scope, task } = bind(taskId);
      if (permitsUnattendedActions(task)) return scope.media.refresh(taskId, jobId(params.job), true);
      const choice = await confirm({ type: "warning", title: "停止这个媒体任务", message: "停止等待并丢弃临时成果？",
        detail: `任务：${task.title}\n媒体任务：${jobId(params.job)}`,
        boundary: "不会删除已保存到云盘的文件；上游生成可能继续执行和计费。",
        buttons: ["返回", "停止并丢弃"], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) throw declined(choice, CANCELLED);
      return scope.media.refresh(taskId, jobId(params.job), true);
    }),
    // The two ways out of an upload whose outcome is unknown. Both only read
    // state and hand back a link for the person to open, so neither writes and
    // neither needs a confirmation.
    "media-verify": telling(async (params, taskId) => {
      const { scope } = bind(taskId);
      scope.driveWriteAccess();
      return scope.mediaDelivery.verify(taskId, jobId(params.job));
    }),
    "media-folder": async (params, taskId) => {
      const { scope } = bind(taskId);
      scope.driveWriteAccess();
      return { url: await scope.mediaDelivery.folder(taskId, jobId(params.job)) };
    },
    // Showing the person the result. The bytes never reach the conversation or
    // the renderer -- the preview is an isolated view the application opens --
    // so this hands over nothing and only needs the job to exist.
    "media-preview": async (params, taskId) => {
      bind(taskId);
      await openPreview(taskId, jobId(params.job));
      return { opened: true };
    },
    "media-save": telling(async (params, taskId) => {
      const { scope, task } = bind(taskId);
      scope.driveWriteAccess();
      const draft = await scope.mediaDelivery.prepare(taskId, jobId(params.job), params.folder);
      if (permitsUnattendedActions(task)) return scope.mediaDelivery.save(draft);
      const choice = await confirm({ type: "warning", title: "确认保存到飞书云盘", message: `保存到「${draft.folder.title}」`,
        detail: `任务：${task.title}\n文件夹：${draft.folder.url}\n文件：${draft.name}\n大小：${draft.bytes.length} 字节\nSHA-256：${draft.sha256}\n托管上传预算剩余：${draft.policy.remainingBytes} / ${draft.policy.maxBytes} 字节`,
        boundary: "以当前 CLI 用户身份新建文件，不覆盖、不修改权限。文件夹的协作者可能看到此成果；请确认保存范围。预算由服务端管理，只约束本应用托管上传。结果未知时保留额度，不自动重传。",
        buttons: ["取消", "确认上传"], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) throw declined(choice, CANCELLED);
      return scope.mediaDelivery.save(draft);
    }),
  };
}
