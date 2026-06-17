import { useState, useCallback } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { saveBackupConfig } from "@/lib/project-store"
import { API_SERVER_BASE_URL } from "@/lib/api-server-constants"
import type { BackupConfig } from "@/stores/wiki-store"

export function BackupSection() {
  const backupConfig = useWikiStore((s) => s.backupConfig)
  const setBackupConfig = useWikiStore((s) => s.setBackupConfig)
  const apiToken = useWikiStore((s) => s.apiConfig.token)

  const [runStatus, setRunStatus] = useState<"idle" | "running" | "ok" | "error">("idle")
  const [runError, setRunError] = useState<string | null>(null)

  const handleChange = useCallback(
    async (next: BackupConfig) => {
      setBackupConfig(next)
      await saveBackupConfig(next)
    },
    [setBackupConfig],
  )

  const handleRunNow = useCallback(async () => {
    setRunStatus("running")
    setRunError(null)
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (apiToken) {
        headers["Authorization"] = `Bearer ${apiToken}`
      }
      const res = await fetch(`${API_SERVER_BASE_URL}/api/v1/backup/run`, {
        method: "POST",
        headers,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(`HTTP ${res.status}: ${text}`)
      }
      setRunStatus("ok")
    } catch (err) {
      setRunStatus("error")
      setRunError(err instanceof Error ? err.message : String(err))
    }
  }, [apiToken])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Backup</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Sincronizza la wiki su un repository GitHub privato ogni 6 ore.
        </p>
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={backupConfig.enabled}
          onChange={(e) =>
            handleChange({ ...backupConfig, enabled: e.target.checked })
          }
          className="mt-0.5 h-4 w-4"
        />
        <div className="space-y-1">
          <span className="text-sm">Abilita backup periodico (ogni 6h)</span>
          <p className="text-xs text-muted-foreground">
            Esegue automaticamente un commit e push al repository remoto ogni 6 ore.
          </p>
        </div>
      </label>

      <div className="space-y-2">
        <Label htmlFor="backup-remote-url">URL repo GitHub privato</Label>
        <Input
          id="backup-remote-url"
          value={backupConfig.remoteUrl}
          onChange={(e) =>
            handleChange({ ...backupConfig, remoteUrl: e.target.value })
          }
          placeholder="https://github.com/username/repo.git"
        />
        <p className="text-xs text-muted-foreground">
          URL HTTPS del repository di backup. Assicurati che il credential helper di{" "}
          <code className="font-mono">gh</code> sia configurato (<code className="font-mono">gh auth setup-git</code>).
        </p>
      </div>

      <div className="space-y-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleRunNow}
          disabled={runStatus === "running"}
        >
          {runStatus === "running" ? "Backup in corso…" : "Esegui backup ora"}
        </Button>
        {runStatus === "ok" && (
          <p className="text-xs text-green-600">Backup avviato con successo.</p>
        )}
        {runStatus === "error" && runError && (
          <p className="text-xs text-destructive">{runError}</p>
        )}
      </div>
    </div>
  )
}
