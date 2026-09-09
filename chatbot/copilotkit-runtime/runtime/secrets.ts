import { existsSync, readFileSync } from "node:fs";

export function readProviderKey(keysPath: string, keyName: string): string | null {
  if (!existsSync(keysPath)) return null;
  for (const line of readFileSync(keysPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 1) continue;
    const name = trimmed.slice(0, separatorIndex).trim();
    if (name !== keyName) continue;
    return trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "") || null;
  }
  return null;
}
