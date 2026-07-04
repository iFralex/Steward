/**
 * A file a tool produced (e.g. a saved attachment), served by the host at
 * /file/<token>. On the Mac: "Apri" opens it in the native app, "Finder" reveals
 * it, and the chip is draggable to copy the file out. On the phone (a remote
 * client) those Mac-only actions are hidden and tapping the file opens an in-app
 * preview overlay instead — so it never navigates out of the PWA (from where iOS
 * gives no way back).
 */
import { useState } from "react";
import { Eye, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authTokenKey, isLocalClient } from "@/lib/auth";
import { hostHttpBase } from "@/lib/host-url";
import type { ChannelFile } from "@steward/protocol";

// /file/<fileToken> is a gated data route; an <img>/<a> can't set an Authorization
// header, so the host's auth token rides along as a query param instead. The base
// is origin-aware so the URL resolves to the Mac's address from the phone too.
const fileUrl = (fileToken: string) => {
  const auth = localStorage.getItem(authTokenKey);
  return `${hostHttpBase()}/file/${fileToken}${auth ? `?token=${encodeURIComponent(auth)}` : ""}`;
};

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

/** Full-screen in-app preview: images render inline, PDFs in an iframe, anything
 *  else offers a download. The overlay's close button is the way back — no
 *  breaking out of the PWA. */
function FilePreview({ url, file, onClose }: { url: string; file: ChannelFile; onClose: () => void }) {
  const isImage = file.mime.startsWith("image/");
  const isPdf = file.mime === "application/pdf";
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90" onClick={onClose}>
      <div className="flex items-center gap-3 p-3 text-white" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
        <a href={url} download={file.name} className="text-sm underline" onClick={(e) => e.stopPropagation()}>
          Scarica
        </a>
        <button type="button" onClick={onClose} className="flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-white/10" aria-label="Chiudi">
          <X className="size-4" /> Chiudi
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2" onClick={(e) => e.stopPropagation()}>
        {isImage ? (
          <img src={url} alt={file.name} className="mx-auto max-h-full max-w-full object-contain" />
        ) : isPdf ? (
          <iframe src={url} title={file.name} className="h-full w-full rounded bg-white" />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-white/80">
            <p>Anteprima non disponibile per questo tipo di file. Usa “Scarica”.</p>
          </div>
        )}
      </div>
    </div>
  );
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
  const local = isLocalClient(); // Mac-only actions (native open / Finder) hidden on the phone
  const [preview, setPreview] = useState(false);
  // On the Mac a browser tab is fine; on the phone stay in the PWA via the overlay.
  const openFile = () => (local ? window.open(url, "_blank") : setPreview(true));
  return (
    <div
      draggable
      onDragStart={(e) => {
        // Chrome/Edge: copies the file to Finder on drop.
        e.dataTransfer.setData("DownloadURL", `${file.mime}:${file.name}:${url}`);
        e.dataTransfer.setData("text/uri-list", url);
        // Internal: lets the approval form / composer attach this file by its
        // local path (path string + full ref as JSON, no re-upload needed).
        if (file.path) e.dataTransfer.setData("application/x-llmwiki-path", file.path);
        e.dataTransfer.setData("application/x-llmwiki-file", JSON.stringify(file));
        e.dataTransfer.effectAllowed = "copy";
      }}
      className="bg-muted/60 hover:bg-muted flex items-center gap-2 rounded-md border px-2 py-1.5"
      title="Trascina per copiare il file"
    >
      <span aria-hidden>{iconFor(file.mime)}</span>
      <button
        type="button"
        onClick={openFile}
        className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
        title={local ? "Anteprima nel browser" : "Anteprima"}
      >
        {file.name}
      </button>
      <span className="text-muted-foreground tabular-nums">{fmtSize(file.size)}</span>
      {local ? (
        <>
          <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => onOpen(file.token)} title="Apri nell'app di sistema">Apri</Button>
          <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => onReveal(file.token)} title="Mostra nel Finder">Finder</Button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setPreview(true)}
          className="text-muted-foreground hover:text-foreground rounded p-1"
          title="Apri l'anteprima"
          aria-label="Apri l'anteprima"
        >
          <Eye className="size-4" />
        </button>
      )}
      {preview && <FilePreview url={url} file={file} onClose={() => setPreview(false)} />}
    </div>
  );
}
