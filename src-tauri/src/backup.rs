//! Periodic, versioned git backup of the project vault to a private
//! GitHub repo. Runs from the always-on background process. Auth is the
//! machine's existing git credential helper (gh token over HTTPS).

use std::path::Path;
use std::process::Command;
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct BackupConfig {
    pub enabled: bool,
    pub remote_url: String,
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

fn git(cwd: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("git {args:?} failed to start: {e}"))
}

/// Initialize the repo if needed, refresh .gitignore, stage, commit only
/// if there are changes, and push. Returns a human-readable status.
pub fn run_backup(project_path: &str, cfg: &BackupConfig) -> Result<String, String> {
    if !cfg.enabled {
        return Ok("backup disabled".to_string());
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
        git(root, &["branch", "-M", "main"])?;
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
    git(root, &["add", "-A"])?;
    // 5. commit only if there are staged changes.
    let dirty = !git(root, &["diff", "--cached", "--quiet"])?.status.success();
    if !dirty {
        return Ok("no changes to back up".to_string());
    }
    let stamp = git(root, &["commit", "-m", "backup: vault snapshot"])?;
    if !stamp.status.success() {
        return Err(format!(
            "git commit failed: {}",
            String::from_utf8_lossy(&stamp.stderr)
        ));
    }
    // 6. push.
    let push = git(root, &["push", "-u", "origin", "main"])?;
    if !push.status.success() {
        return Err(format!(
            "git push failed: {}",
            String::from_utf8_lossy(&push.stderr)
        ));
    }
    Ok("backup pushed".to_string())
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
