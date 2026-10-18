//! Shared settings in %LOCALAPPDATA%\ai-assistant (override with
//! AI_ASSISTANT_HOME). The Cursor extension and hooks read the same files.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub n8n_url: String,
    pub exclude_globs: Vec<String>,
    pub capture_window_titles: bool,
    pub idle_seconds: u64,
    pub output_tail_lines: u32,
    pub batch_size: usize,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            n8n_url: "http://localhost:5678".into(),
            exclude_globs: vec![],
            capture_window_titles: true,
            idle_seconds: 120,
            output_tail_lines: 40,
            batch_size: 200,
        }
    }
}

pub fn data_dir() -> PathBuf {
    if let Ok(home) = std::env::var("AI_ASSISTANT_HOME") {
        return PathBuf::from(home);
    }
    let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(local).join("ai-assistant")
}

pub fn spool_dir() -> PathBuf {
    data_dir().join("spool")
}

pub fn logs_dir() -> PathBuf {
    data_dir().join("logs")
}

pub fn config_path() -> PathBuf {
    data_dir().join("config.json")
}

pub fn paused_path() -> PathBuf {
    data_dir().join("paused")
}

pub fn state_path() -> PathBuf {
    data_dir().join("state.json")
}

pub fn load() -> Config {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Creates the data directories and a default config.json if missing.
pub fn init() -> std::io::Result<PathBuf> {
    fs::create_dir_all(spool_dir())?;
    fs::create_dir_all(logs_dir())?;
    let path = config_path();
    if !path.exists() {
        fs::write(&path, serde_json::to_string_pretty(&Config::default())?)?;
    }
    Ok(path)
}

pub fn is_paused() -> bool {
    paused_path().exists()
}

pub fn set_paused(paused: bool) -> std::io::Result<()> {
    fs::create_dir_all(data_dir())?;
    if paused {
        fs::write(paused_path(), crate::models::iso8601(crate::models::now_secs()))
    } else if paused_path().exists() {
        fs::remove_file(paused_path())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_config_uses_defaults() {
        let c: Config = serde_json::from_str(r#"{ "n8nUrl": "http://127.0.0.1:9999", "idleSeconds": 60 }"#).unwrap();
        assert_eq!(c.n8n_url, "http://127.0.0.1:9999");
        assert_eq!(c.idle_seconds, 60);
        assert!(c.capture_window_titles);
        assert_eq!(c.batch_size, 200);
    }
}
