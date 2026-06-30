/**
 * A file a tool produced (e.g. a saved attachment), served by the host at
 * /file/<token>. Click the name to preview in a tab; "Apri" opens it in the
 * macOS default app; "Finder" reveals it; and the chip is draggable so dropping
 * it on Finder copies the file out (Chrome/Edge via DownloadURL; Safari ignores
 * that, but open/preview/reveal still work).
 */
import { Button } from "@/components/ui/button";
import type { ChannelFile } from "@llm-wiki/protocol";

const HTTP_BASE = (import.meta.env.VITE_HOST_URL ?? "ws://127.0.0.1:4317").replace(/^ws/, "http");
const fileUrl = (token: string) => `${HTTP_BASE}/file/${token}`;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(mime: string): string {
  if (mime.startsWith("image/")) return "🖼️";
  if (mime === "application/pdf") return "📄";
  if (mime.includes("sheet") || mime.includes("excel") || mime === "text/csv") return "📊";
  if (mime.includes("zip")) return "🗜️";
  if (mime === "message/rfc822") return "✉️";
  if (mime.startsWith("text/") || mime.includes("json") || mime.includes("xml")) return "📃";
  return "📎";
}

export function FileChip({
  file,
  onOpen,
  onReveal,
}: {
  file: ChannelFile;
  onOpen: (token: string) => void;
  onReveal: (token: string) => void;
}) {
  const url = fileUrl(file.token);
  return (
    <div
      draggable
      onDragStart={(e) => {
        // Chrome/Edge: copies the file to Finder on drop.
        e.dataTransfer.setData("DownloadURL", `${file.mime}:${file.name}:${url}`);
        e.dataTransfer.setData("text/uri-list", url);
        e.dataTransfer.effectAllowed = "copy";
      }}
      className="bg-muted/60 hover:bg-muted flex items-center gap-2 rounded-md border px-2 py-1.5"
      title="Trascina per copiare il file"
    >
      <span aria-hidden>{iconFor(file.mime)}</span>
      <button
        type="button"
        onClick={() => window.open(url, "_blank")}
        className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
        title="Anteprima nel browser"
      >
        {file.name}
      </button>
      <span className="text-muted-foreground tabular-nums">{fmtSize(file.size)}</span>
      <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => onOpen(file.token)} title="Apri nell'app di sistema">Apri</Button>
      <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => onReveal(file.token)} title="Mostra nel Finder">Finder</Button>
    </div>
  );
}
