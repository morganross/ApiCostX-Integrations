import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const VALUE_PREFIX = "acxenc:v1";
const WRAP_PREFIX = "acxwrap:v1";

export type EncryptionContext = {
  userUuid: string;
  table: string;
  column: string;
  rowId: string;
};

export class AssistantDataEncryption {
  private readonly kek: Buffer;

  constructor(kekHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(kekHex.trim())) {
      throw new Error("ACM2_ASSISTANT_DATA_KEK must be exactly 32 bytes encoded as 64 hexadecimal characters");
    }
    this.kek = Buffer.from(kekHex.trim(), "hex");
  }

  generateUserKey(): Buffer {
    return randomBytes(32);
  }

  keyCheck(): string {
    return createHmac("sha256", this.kek)
      .update("acx-assistant-data-kek-check-v1", "utf8")
      .digest("hex");
  }

  matchesKeyCheck(expected: string): boolean {
    if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
    return timingSafeEqual(Buffer.from(this.keyCheck(), "hex"), Buffer.from(expected, "hex"));
  }

  wrapUserKey(userUuid: string, userKey: Buffer): string {
    if (userKey.length !== 32) throw new Error("Assistant user data key must be 32 bytes");
    return seal(WRAP_PREFIX, this.kek, wrapAad(userUuid), userKey);
  }

  unwrapUserKey(userUuid: string, wrapped: string): Buffer {
    const key = open(WRAP_PREFIX, this.kek, wrapAad(userUuid), wrapped);
    if (key.length !== 32) throw new Error("Invalid unwrapped assistant user data key length");
    return key;
  }

  encrypt(userKey: Buffer, context: EncryptionContext, plaintext: string): string {
    return seal(VALUE_PREFIX, userKey, valueAad(context), Buffer.from(plaintext, "utf8"));
  }

  decrypt(userKey: Buffer, context: EncryptionContext, ciphertext: string): string {
    return open(VALUE_PREFIX, userKey, valueAad(context), ciphertext).toString("utf8");
  }

  isEncrypted(value: unknown): value is string {
    return typeof value === "string" && value.startsWith(`${VALUE_PREFIX}:`);
  }
}

function seal(prefix: string, key: Buffer, aad: Buffer, plaintext: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [prefix, b64(nonce), b64(ciphertext), b64(tag)].join(":");
}

function open(prefix: string, key: Buffer, aad: Buffer, encoded: string): Buffer {
  const parts = encoded.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== prefix) {
    throw new Error("Invalid assistant encrypted value format");
  }
  const nonce = fromB64(parts[2]);
  const ciphertext = fromB64(parts[3]);
  const tag = fromB64(parts[4]);
  if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid assistant encrypted value parameters");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function valueAad(context: EncryptionContext): Buffer {
  return Buffer.from(
    ["acx-assistant-data", "v1", context.userUuid, context.table, context.column, context.rowId].join("\0"),
    "utf8"
  );
}

function wrapAad(userUuid: string): Buffer {
  return Buffer.from(["acx-assistant-user-key", "v1", userUuid].join("\0"), "utf8");
}

function b64(value: Buffer): string {
  return value.toString("base64url");
}

function fromB64(value: string | undefined): Buffer {
  if (typeof value !== "string") throw new Error("Invalid assistant encrypted value segment");
  return Buffer.from(value, "base64url");
}
