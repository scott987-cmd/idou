import { createHash } from "node:crypto";
import { MediaDownloader } from "./media-download.js";
import { DriveBudgetClient } from "./drive-budget-client.js";
import { EITHER, ownFileName } from "../product-names.js";
// A saved image or video, under either spelling of the product's name (product-names.js).
const MEDIA_NAME = new RegExp(`^${EITHER}-[a-f0-9-]{36}\\.(png|jpg|webp|mp4)$`);
const opaque = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x20]/.test(value);
function cloudUrl(value) { const url = new URL(value); if (typeof value !== "string" || value.length > 2048 || url.protocol !== "https:" || url.username || url.password) throw new Error("云盘链接无效"); }

export function validateDelivery(value) {
  if (!value || !["prepared", "uploading", "upload_unknown", "verification_pending", "available"].includes(value.state) || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 104857600 || !/^[a-f0-9]{64}$/.test(value.sha256) || !MEDIA_NAME.test(value.name) || typeof value.folder?.identity?.principal !== "string" || !/^[a-f0-9]{64}$/.test(value.folder.identity.principal) || !opaque(value.folder.identity.tenantKey) || !opaque(value.folder.providerId) || typeof value.folder.title !== "string" || value.folder.title.length > 300 || !opaque(value.folder.token) || (value.fileToken !== null && !opaque(value.fileToken))) throw new Error("云盘保存记录无效，原记录未修改");
  cloudUrl(value.folder.url);
  if (value.budget !== undefined && (!value.budget || Object.keys(value.budget).some((key) => key !== "policyDigest") || !/^[a-f0-9]{64}$/.test(value.budget.policyDigest))) throw new Error("云盘预算记录无效");
  if (["verification_pending", "available"].includes(value.state) && !value.fileToken) throw new Error("云盘保存记录缺少文件标识");
  return value;
}

// Uses the account-scoped media journal for reservations; only the provider knows
// Feishu URL/CLI details. Bytes stay native and are never stored by control plane.
export class MediaDelivery {
  constructor({ media, provider, businessAccess, downloader = new MediaDownloader(), budget = new DriveBudgetClient(media) }) { Object.assign(this, { media, provider, businessAccess, downloader, budget }); }
  async owned(taskId, id) {
    this.businessAccess(); this.media.task(taskId); await this.media.load();
    const row = this.media.rows.find((item) => item.taskId === taskId && item.id === id);
    if (!row) throw new Error("找不到当前任务的媒体记录");
    const session = await this.media.session(), lease = await this.media.lease(session, row.kind);
    if (row.ownerKey !== lease.ownerKey) throw new Error("媒体成果不属于当前账号或服务端");
    return { row, session };
  }
  async prepare(taskId, id, reference) {
    const { row } = await this.owned(taskId, id);
    if (row.delivery && row.delivery.state !== "prepared") throw new Error("已有云盘保存记录，请核查原文件，不能再次上传");
    const folder = await this.provider.resolveFolder(reference), result = await this.media.result(taskId, id);
    const media = await this.downloader.download(result);
    const policy = await this.budget.policy(result.session, folder, media.bytes.length);
    await this.media.unchanged(result.session); await this.provider.unchanged(folder.identity);
    return { taskId, id, folder, policy, bytes: media.bytes, name: ownFileName(`${row.id}.${media.extension}`), sha256: createHash("sha256").update(media.bytes).digest("hex"), session: result.session };
  }
  save(draft) {
    return this.media.serial(async () => {
      const { row } = await this.owned(draft.taskId, draft.id);
      await this.media.unchanged(draft.session);
      if (row.delivery && row.delivery.state !== "prepared") throw new Error("该成果已有上传记录，未重复上传");
      const current = await this.media.inspect(draft.taskId, draft.id);
      if (!current.job?.result) throw new Error("确认期间临时成果已失效，未上传");
      row.delivery = { state: "prepared", folder: draft.folder, bytes: draft.bytes.length, sha256: draft.sha256, name: draft.name, fileToken: null, budget: { policyDigest: draft.policy.policyDigest } };
      validateDelivery(row.delivery); await this.media.save();
      try {
        const receipt = await this.provider.upload({ bytes: draft.bytes, name: draft.name, folder: draft.folder, confirmed: true,
          onDispatched: async () => {
            this.businessAccess(); await this.media.unchanged(draft.session);
            await this.budget.reserve(draft.session, row.id, row.delivery, draft.policy.policyDigest);
            row.delivery.state = "uploading"; await this.media.save();
            await this.budget.dispatch(draft.session, row.id, draft.policy.policyDigest);
          },
          onUploaded: async (fileToken) => { row.delivery.fileToken = fileToken; row.delivery.state = "verification_pending"; await this.media.save(); },
        });
        if (row.delivery.state !== "verification_pending" || receipt?.fileToken !== row.delivery.fileToken) throw new Error("上传回执未完整记录，未确认保存成功");
        await this.budget.report(draft.session, row.id, row.delivery.fileToken);
        await this.media.unchanged(draft.session); row.delivery.state = "available"; await this.media.save();
      } catch (error) {
        if (row.delivery.state === "uploading") row.delivery.state = "upload_unknown";
        if (row.delivery.state === "available") row.delivery.state = "verification_pending";
        await this.media.save(); throw error;
      }
      return this.media.public(row);
    });
  }
  verify(taskId, id) {
    return this.media.serial(async () => {
      const { row, session } = await this.owned(taskId, id), delivery = row.delivery;
      if (!delivery?.fileToken) throw new Error("上传结果未知且没有文件标识，请在原文件夹人工核查；应用不会自动重传");
      validateDelivery(delivery);
      const receipt = await this.provider.verify({ folder: delivery.folder, name: delivery.name, fileToken: delivery.fileToken });
      if (receipt?.fileToken !== delivery.fileToken) throw new Error("云盘核验返回了不同的文件标识");
      if (delivery.budget) await this.budget.report(session, row.id, delivery.fileToken);
      await this.media.unchanged(session); delivery.state = "available";
      try { await this.media.save(); } catch (error) { delivery.state = "verification_pending"; throw error; }
      return receipt;
    });
  }
  folder(taskId, id) {
    return this.media.serial(async () => {
      const { row, session } = await this.owned(taskId, id);
      if (!row.delivery) throw new Error("没有待核查的保存记录");
      const folder = await this.provider.resolveFolder(row.delivery.folder.url);
      if (folder.identity.principal !== row.delivery.folder.identity.principal) throw new Error("当前 CLI 不是上传时的账号");
      await this.media.unchanged(session); return folder.url;
    });
  }
}
