//! Periodic, versioned git backup of the project vault to a private
//! GitHub repo. Runs from the always-on background process. Auth is the
//! machine's existing git credential helper (gh token over HTTPS).

use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct BackupConfig {
    pub enabled: bool,
    pub remote_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRunResult {
    pub status: String,
    pub pushed: bool,
    pub commit: Option<String>,
    pub pushed_at: Option<u64>,
    pub remote_url: Option<String>,
}

/// `.gitignore` for the backup repo. Excludes regenerable caches that
/// cost no tokens to rebuild, transient work-in-progress state, the
/// large/noisy vector DB, and the app config (no secrets). Everything
/// else under the project — wiki, schema, raw/sources, valuable
/// .llm-wiki state, and the token-costly caches (ingest-cache,
/// image-caption-cache) — is committed.
pub fn backup_gitignore() -> &'static str {
    "# LLM Wiki vault backup — exclude regenerable / transient / secrets\n\
.llm-wiki/lancedb/\n\
.llm-wiki/file-snapshot.json\n\
.llm-wiki/file-change-queue.json\n\
.llm-wiki/ingest-queue.json\n\
.llm-wiki/ingest-progress/\n\
.llm-wiki/dedup-queue.json\n\
.llm-wiki/lint.json\n\
.llm-wiki/db.json\n\
app-state.json\n"
}

/// Read backup config from app-state.json. Shape (top-level):
/// `"backupConfig": { "enabled": bool, "remoteUrl": "https://github.com/.../x.git" }`.
pub fn read_backup_config(store_path: &Path) -> BackupConfig {
    let parsed = std::fs::read_to_string(store_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let cfg = parsed.as_ref().and_then(|p| p.get("backupConfig"));
    BackupConfig {
        enabled: cfg
            .and_then(|c| c.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        remote_url: cfg
            .and_then(|c| c.get("remoteUrl"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }
}

pub fn write_backup_status(store_path: &Path, result: &BackupRunResult) -> Result<(), String> {
    if !result.pushed {
        return Ok(());
    }
    let mut root = std::fs::read_to_string(store_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    root.insert(
        "backupStatus".to_string(),
        serde_json::to_value(result).map_err(|e| format!("failed to serialize backup status: {e}"))?,
    );
    let raw = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("failed to encode app-state.json: {e}"))?;
    std::fs::write(store_path, raw).map_err(|e| format!("failed to write app-state.json: {e}"))
}

fn git(cwd: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("git {args:?} failed to start: {e}"))
}

/// Initialize the repo if needed, refresh .gitignore, stage, commit only
/// if there are changes, and push. Returns a structured status for UI/API use.
pub fn run_backup(project_path: &str, cfg: &BackupConfig) -> Result<BackupRunResult, String> {
    if !cfg.enabled {
        return Ok(BackupRunResult {
            status: "backup disabled".to_string(),
            pushed: false,
            commit: None,
            pushed_at: None,
            remote_url: None,
        });
    }
    if cfg.remote_url.trim().is_empty() {
        return Err("backup remote_url is empty".to_string());
    }
    let root = Path::new(project_path);
    if !root.exists() {
        return Err(format!("project path does not exist: {project_path}"));
    }

    // 1. git init (idempotent).
    if !root.join(".git").exists() {
        git(root, &["init"])?;
    }
    // 2. remote origin (set or update).
    let has_origin = git(root, &["remote", "get-url", "origin"])
        .map(|o| o.status.success())
        .unwrap_or(false);
    if has_origin {
        git(root, &["remote", "set-url", "origin", &cfg.remote_url])?;
    } else {
        git(root, &["remote", "add", "origin", &cfg.remote_url])?;
    }
    // 3. refresh .gitignore.
    std::fs::write(root.join(".gitignore"), backup_gitignore())
        .map_err(|e| format!("failed to write .gitignore: {e}"))?;
    // 4. stage everything.
    let add_out = git(root, &["add", "-A"])?;
    if !add_out.status.success() {
        return Err(format!("git add failed: {}", String::from_utf8_lossy(&add_out.stderr)));
    }
    // 5. commit only if there are staged changes.
    let dirty = !git(root, &["diff", "--cached", "--quiet"])?.status.success();
    if !dirty {
        return Ok(BackupRunResult {
            status: "no changes to back up".to_string(),
            pushed: false,
            commit: None,
            pushed_at: None,
            remote_url: None,
        });
    }
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let commit_msg = format!("backup: vault snapshot ({}s)", secs);
    let stamp = git(root, &["commit", "-m", &commit_msg])?;
    if !stamp.status.success() {
        return Err(format!(
            "git commit failed: {}",
            String::from_utf8_lossy(&stamp.stderr)
        ));
    }
    // 6. push.
    let push = git(root, &["push", "-u", "origin", "HEAD:main"])?;
    if !push.status.success() {
        return Err(format!(
            "git push failed: {}",
            String::from_utf8_lossy(&push.stderr)
        ));
    }
    let commit = git(root, &["rev-parse", "HEAD"])
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|hash| !hash.is_empty());
    Ok(BackupRunResult {
        status: "backup pushed".to_string(),
        pushed: true,
        commit,
        pushed_at: Some(secs),
        remote_url: Some(cfg.remote_url.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitignore_excludes_regenerable_and_includes_value() {
        let gi = backup_gitignore();
        // Escluse: cache rigenerabile gratis / transitori / segreti.
        assert!(gi.contains(".llm-wiki/lancedb/"));
        assert!(gi.contains(".llm-wiki/file-snapshot.json"));
        assert!(gi.contains(".llm-wiki/ingest-queue.json"));
        assert!(gi.contains(".llm-wiki/lint.json"));
        assert!(gi.contains("app-state.json"));
        // NON escluse (di valore o costose in token): non devono comparire.
        assert!(!gi.contains(".llm-wiki/ingest-cache.json"));
        assert!(!gi.contains(".llm-wiki/image-caption-cache.json"));
        assert!(!gi.contains(".llm-wiki/page-history"));
        assert!(!gi.contains(".llm-wiki/review.json"));
    }
}
