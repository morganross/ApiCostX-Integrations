import { StringDecoder } from "node:string_decoder";

export class ThreadIdStreamRedactor {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";

  constructor(
    private readonly scopedThreadId: string,
    private readonly publicThreadId: string
  ) {
    if (!scopedThreadId || !publicThreadId) throw new Error("Thread id response mapping requires both ids");
  }

  push(chunk: string | Buffer | Uint8Array): string {
    this.pending += this.decoder.write(toBuffer(chunk));
    return this.drain(false);
  }

  finish(chunk?: string | Buffer | Uint8Array): string {
    if (chunk !== undefined) this.pending += this.decoder.write(toBuffer(chunk));
    this.pending += this.decoder.end();
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let output = "";
    while (true) {
      const matchIndex = this.pending.indexOf(this.scopedThreadId);
      if (matchIndex >= 0) {
        output += this.pending.slice(0, matchIndex);
        output += this.publicThreadId;
        this.pending = this.pending.slice(matchIndex + this.scopedThreadId.length);
        continue;
      }
      if (final) {
        output += this.pending;
        this.pending = "";
        return output;
      }
      const keep = longestSuffixPrefix(this.pending, this.scopedThreadId);
      const flushLength = this.pending.length - keep;
      output += this.pending.slice(0, flushLength);
      this.pending = this.pending.slice(flushLength);
      return output;
    }
  }
}

function longestSuffixPrefix(value: string, target: string): number {
  const maximum = Math.min(value.length, target.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (value.endsWith(target.slice(0, length))) return length;
  }
  return 0;
}

function toBuffer(value: string | Buffer | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}
