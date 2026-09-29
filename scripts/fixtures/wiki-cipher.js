// Test-only AES-GCM cipher. Does not exercise the operating-system key store.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
export function fixtureCipher(key = randomBytes(32)) {
  return {
    available: () => true,
    encrypt: (text) => {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decrypt: (bytes) => {
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
}
