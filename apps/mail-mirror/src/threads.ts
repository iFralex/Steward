export class ThreadIndex {
  private parent = new Map<string, string>();

  private find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(ids: string[]): void {
    const present = ids.filter((i) => i && i.length);
    if (present.length === 0) return;
    const first = this.find(present[0]);
    for (const id of present.slice(1)) {
      this.parent.set(this.find(id), first);
    }
  }

  rootOf(id: string): string {
    return this.find(id);
  }

  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const r = this.find(id);
      const arr = out.get(r) ?? [];
      arr.push(id);
      out.set(r, arr);
    }
    return out;
  }
}

const PREFIX_RE = /^\s*(re|fwd|fw|r|aw|i)\s*:\s*/i;

export function normalizeSubject(s: string): string {
  let out = s ?? "";
  let prev;
  do {
    prev = out;
    out = out.replace(PREFIX_RE, "");
  } while (out !== prev);
  return out.trim();
}
