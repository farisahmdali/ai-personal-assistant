//! Structured diagnostics: one JSON object per line in logs\monitor.log,
//! rotated to monitor.log.1 at 5 MB.

use crate::{config, models};
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::Write;

const MAX_BYTES: u64 = 5 * 1024 * 1024;

fn write(level: &str, message: &str, fields: Value) {
    let dir = config::logs_dir();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("monitor.log");
    if fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("monitor.log.1"));
    }

    let line = json!({
        "ts": models::iso8601(models::now_secs()),
        "level": level,
        "message": message,
        "fields": fields
    });
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", line);
    }
}

pub fn info(message: &str, fields: Value) {
    write("info", message, fields);
}

pub fn warn(message: &str, fields: Value) {
    write("warn", message, fields);
}
