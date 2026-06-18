import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export class BlobStore {
  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
  }

  put(content: Buffer): { sha256: string; relPath: string } {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const relPath = join(sha256.slice(0, 2), sha256);
    const abs = this.absPath(relPath);
    if (!existsSync(abs)) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    return { sha256, relPath };
  }

  absPath(relPath: string): string {
    return join(this.rootDir, relPath);
  }
}
