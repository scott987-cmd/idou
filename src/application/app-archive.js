import { DriveBudgetClient } from "./drive-budget-client.js";
import { archiveInput, archiveRecord, archiveInputKey, appPackage } from "../apps/archive.js";
import { ownFileName } from "../product-names.js";

// Source bytes never cross the control plane. The server owns a one-shot archive
// id, so restarting/using another device cannot silently allocate a new upload.
export class AppArchive {
  constructor({ candidates, provider, businessAccess, budget = new DriveBudgetClient(candidates) }) { Object.assign(this, { candidates, provider, businessAccess, budget }); this.queue = Promise.resolve(); }
  serial(fn) { const run = this.queue.then(fn); this.queue = run.catch(() => {}); return run; }
  async candidate(id, digest, session) {
    this.businessAccess(); await this.candidates.unchanged(session);
    const row = (await this.candidates.list(id)).find((r) => r.digest === digest);
    await this.candidates.unchanged(session);
    if (!row) throw new Error("当前账号找不到这个应用版本"); return row;
  }
  async command(session, action, body) {
    await this.candidates.unchanged(session);
    const token = await this.candidates.lease(session), result = await this.candidates.request(session, `/v1/apps/archive-${action}`, token, body);
    archiveRecord(result.archive);
    if ((body.id && result.archive.id !== body.id) || (body.fileToken && result.archive.fileToken !== body.fileToken) || (body.input && archiveInputKey(body.input) !== archiveInputKey(result.archive.input))) throw new Error("应用归档响应与请求不一致，请刷新核查");
    return result;
  }
  async prepare(id, digest, reference) {
    const session = await this.candidates.session(), row = await this.candidate(id, digest, session);
    if (row.state !== "submitted" || (row.archive && row.archive.state !== "prepared")) throw new Error("版本已撤回或已有归档记录，请核查原成果，不要重传");
    const pkg = await this.candidates.package(digest), folder = await this.provider.resolveFolder(reference);
    if (row.totalBytes !== pkg.totalBytes || row.entry !== pkg.manifest.entry || row.fileCount !== pkg.manifest.files.length) throw new Error("归档包与服务端版本清单不一致");
    const policy = await this.budget.policy(session, folder, pkg.bytes.length);
    await this.candidates.unchanged(session); await this.provider.unchanged(folder.identity);
    return { id, digest, title: row.title, session, bytes: pkg.bytes, input: archiveInput({ folder, bytes: pkg.bytes.length, sha256: pkg.sha256, policyDigest: policy.policyDigest }) };
  }
  save(draft) {
    return this.serial(async () => {
      const row = await this.candidate(draft.id, draft.digest, draft.session);
      if (row.state !== "submitted") throw new Error("版本已撤回，未上传");
      const pkg = appPackage(draft.bytes, draft.digest), input = archiveInput(draft.input);
      if (pkg.bytes.length !== input.bytes || pkg.sha256 !== input.sha256) throw new Error("确认的应用版本包已变化");
      await this.provider.unchanged(input.folder.identity);
      const key = { appId: draft.id, digest: draft.digest };
      let record = (await this.command(draft.session, "prepare", { ...key, input })).archive;
      const name = ownFileName(`${record.id}.app.json`);
      const receipt = await this.provider.upload({ bytes: pkg.bytes, name, folder: input.folder, confirmed: true,
        onDispatched: async () => {
          this.businessAccess(); await this.candidate(draft.id, draft.digest, draft.session);
          await this.budget.reserve(draft.session, record.id, input, input.policyDigest);
          const permit = await this.command(draft.session, "dispatch", { ...key, id: record.id });
          if (permit.granted !== true || permit.archive.id !== record.id || permit.archive.state !== "uploading") throw new Error("未取得应用归档许可，未重传");
          await this.budget.dispatch(draft.session, record.id, input.policyDigest);
        },
        onUploaded: async (fileToken) => { record = (await this.command(draft.session, "receipt", { ...key, id: record.id, fileToken })).archive; },
      });
      if (!record.fileToken || receipt?.fileToken !== record.fileToken) throw new Error("应用归档回执不一致，请核查原文件");
      await this.budget.report(draft.session, record.id, record.fileToken);
      return this.command(draft.session, "verify", { ...key, id: record.id, fileToken: record.fileToken });
    });
  }
  verify(id, digest) {
    return this.serial(async () => {
      const session = await this.candidates.session(), row = await this.candidate(id, digest, session), record = row.archive;
      if (!record?.fileToken) throw new Error("没有已记录的文件标识，请在原云盘文件夹人工核查；不会自动重传");
      archiveRecord(record);
      const receipt = await this.provider.verify({ folder: record.input.folder, name: ownFileName(`${record.id}.app.json`), fileToken: record.fileToken });
      if (receipt?.fileToken !== record.fileToken) throw new Error("云盘核验返回了不同的文件标识");
      await this.budget.report(session, record.id, record.fileToken);
      return this.command(session, "verify", { appId: id, digest, id: record.id, fileToken: record.fileToken });
    });
  }
  async readVerified(id, digest) {
      const session = await this.candidates.session(), row = await this.candidate(id, digest, session), record = row.archive;
      if (!record?.fileToken) throw new Error("没有已记录的云盘文件，无法取回版本包");
      archiveRecord(record);
      const bytes = await this.provider.download({ folder: record.input.folder, name: ownFileName(`${record.id}.app.json`), fileToken: record.fileToken, maxBytes: record.input.bytes });
      const pkg = appPackage(bytes, digest);
      if (pkg.bytes.length !== record.input.bytes || pkg.sha256 !== record.input.sha256 || pkg.totalBytes !== row.totalBytes || pkg.manifest.entry !== row.entry || pkg.manifest.files.length !== row.fileCount) throw new Error("云盘包与已确认版本不一致，未保存或执行");
      const current = await this.candidate(id, digest, session);
      if (current.state !== row.state || !current.archive || current.archive.id !== record.id || current.archive.fileToken !== record.fileToken || archiveInputKey(current.archive.input) !== archiveInputKey(record.input)) throw new Error("取回期间应用版本或归档记录发生变化");
      await this.provider.unchanged(record.input.folder.identity); await this.candidates.unchanged(session);
      return { pkg, session, title: row.title };
  }
  preview(id, digest) {
    return this.serial(async () => {
      const result = await this.readVerified(id, digest);
      return { ...result, expiresAt: Math.min(result.session.expiresAt, Date.now() + 300000) };
    });
  }
  retrieve(id, digest) {
    return this.serial(async () => {
      const { pkg, session } = await this.readVerified(id, digest);
      await this.candidates.persist(pkg); await this.candidates.unchanged(session);
      // No server-side "verified" claim: these are local read-time checks, not
      // deployment authorization or continuously current source permissions.
      return { digest, sha256: pkg.sha256, bytes: pkg.bytes.length, verifiedAt: Date.now(), files: pkg.manifest.files, entry: pkg.manifest.entry };
    });
  }
}
