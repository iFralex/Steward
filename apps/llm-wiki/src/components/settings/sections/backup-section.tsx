import { useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useWikiStore } from "@/stores/wiki-store"
import { saveBackupConfig, saveBackupStatus } from "@/lib/project-store"
import { API_SERVER_BASE_URL } from "@/lib/api-server-constants"
import type { BackupConfig, BackupStatus } from "@/stores/wiki-store"

type BackupRunResponse = {
  status?: string
  result?: BackupStatus
}

function formatBackupTime(value?: number | null): string | null {
  if (!value) return null
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1000))
}

export function BackupSection() {
  const { t } = useTranslation()
  const backupConfig = useWikiStore((s) => s.backupConfig)
  const backupStatus = useWikiStore((s) => s.backupStatus)
  const setBackupConfig = useWikiStore((s) => s.setBackupConfig)
  const setBackupStatus = useWikiStore((s) => s.setBackupStatus)
  const apiToken = useWikiStore((s) => s.apiConfig.token)

  const [runStatus, setRunStatus] = useState<"idle" | "running" | "ok" | "error">("idle")
  const [runError, setRunError] = useState<string | null>(null)
  const [runMessage, setRunMessage] = useState<string | null>(null)

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
    setRunMessage(null)
    try {
      const headers: Record<string, string> = {}
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
      const body = (await res.json().catch(() => null)) as BackupRunResponse | null
      const result = body?.result
      setRunMessage(result?.status ?? body?.status ?? null)
      if (result?.pushed) {
        setBackupStatus(result)
        await saveBackupStatus(result)
      }
      setRunStatus("ok")
    } catch (err) {
      setRunStatus("error")
      setRunError(err instanceof Error ? err.message : String(err))
    }
  }, [apiToken, setBackupStatus])

  const lastPushTime = formatBackupTime(backupStatus?.pushedAt)
  const shortCommit = backupStatus?.commit ? backupStatus.commit.slice(0, 12) : null

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.backup.title", { defaultValue: "Backup" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.backup.description", {
            defaultValue: "Sync the wiki to a private GitHub repository every 6 hours.",
          })}
        </p>
      </div>

      <label className="flex items-start gap-3" htmlFor="backup-enabled">
        <Switch
          id="backup-enabled"
          checked={backupConfig.enabled}
          onCheckedChange={(checked) =>
            handleChange({ ...backupConfig, enabled: checked })
          }
          className="mt-0.5"
        />
        <div className="space-y-1">
          <span className="text-sm">
            {t("settings.sections.backup.enable", {
              defaultValue: "Enable periodic backup (every 6h)",
            })}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.backup.enableHint", {
              defaultValue:
                "Automatically commits and pushes to the remote repository every 6 hours.",
            })}
          </p>
        </div>
      </label>

      <div className="space-y-2">
        <Label htmlFor="backup-remote-url">
          {t("settings.sections.backup.remoteUrl", { defaultValue: "Private GitHub repo URL" })}
        </Label>
        <Input
          id="backup-remote-url"
          value={backupConfig.remoteUrl}
          onChange={(e) =>
            handleChange({ ...backupConfig, remoteUrl: e.target.value })
          }
          placeholder="https://github.com/username/repo.git"
        />
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.backup.remoteUrlHint", {
            defaultValue:
              "HTTPS URL of the backup repository. Make sure the gh credential helper is configured (gh auth setup-git).",
          })}
        </p>
      </div>

      <div className="space-y-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleRunNow}
          disabled={runStatus === "running"}
        >
          {runStatus === "running"
            ? t("settings.sections.backup.running", { defaultValue: "Backup in progress…" })
            : t("settings.sections.backup.runNow", { defaultValue: "Run backup now" })}
        </Button>
        {runStatus === "ok" && (
          <p className="text-xs text-green-600">
            {runMessage ??
              t("settings.sections.backup.runOk", { defaultValue: "Backup completed." })}
          </p>
        )}
        {runStatus === "error" && runError && (
          <p className="text-xs text-destructive">{runError}</p>
        )}
        {backupStatus?.pushed && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.backup.lastSuccess", {
              defaultValue: "Last successful push",
            })}
            {lastPushTime ? `: ${lastPushTime}` : ""}
            {shortCommit ? ` · ${shortCommit}` : ""}
          </p>
        )}
      </div>
    </div>
  )
}
