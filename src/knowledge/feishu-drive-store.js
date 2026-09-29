export class FeishuDriveKnowledgeStore {
  constructor(provider, { folderToken, maxBytes, reserveBytes = 0 }) {
    if (!folderToken) throw new Error("a Feishu Drive folder token is required");
    this.provider = provider;
    this.folderToken = folderToken;
    this.maxBytes = maxBytes;
    this.reserveBytes = reserveBytes;
  }

  assertBudget({ committedBytes, pendingBytes }) {
    for (const [name, value] of Object.entries({ committedBytes, pendingBytes })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error("maxBytes must be a positive integer");
    }
    const usableBytes = Math.max(0, this.maxBytes - this.reserveBytes);
    if (committedBytes + pendingBytes > usableBytes) {
      throw new Error("knowledge sync would exceed the configured Feishu Drive budget");
    }
  }

  async status(localDir, { quick = true } = {}) {
    const args = [
      "drive",
      "+status",
      "--as",
      "user",
      "--folder-token",
      this.folderToken,
      "--local-dir",
      localDir,
      "--json",
    ];
    if (quick) args.push("--quick");
    return this.provider.invoke(args);
  }

  async push(localDir) {
    return this.provider.invoke([
      "drive",
      "+push",
      "--as",
      "user",
      "--folder-token",
      this.folderToken,
      "--local-dir",
      localDir,
      "--if-exists",
      "smart",
      "--on-duplicate-remote",
      "fail",
      "--json",
    ]);
  }

  async quota(userId) {
    if (typeof userId !== "string" || userId.length === 0) throw new Error("userId is required");
    return this.provider.invoke([
      "drive",
      "quota_details",
      "get",
      "--as",
      "user",
      "--quota-detail-id",
      userId,
      "--json",
    ]);
  }
}

