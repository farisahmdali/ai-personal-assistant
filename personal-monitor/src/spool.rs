//! Local event queue shared by all collectors: one JSON event per line in
//! `<source>-<millis>-<pid>-<seq>.jsonl`, written as `.tmp` and renamed so a
//! reader never sees a half-written file. Files are deleted only after n8n
//! accepted them, so nothing is lost across restarts or outages.

use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn write_events(dir: &Path, source: &str, events: &[Value]) -> io::Result<Option<PathBuf>> {
    if events.is_empty() {
        return Ok(None);
    }
    fs::create_dir_all(dir)?;

    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = format!("{}-{}-{}-{}.jsonl", source, millis, std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let path = dir.join(name);
    let tmp = path.with_extension("jsonl.tmp");

    let mut body = String::new();
    for event in events {
        body.push_str(&event.to_string());
        body.push('\n');
    }
    fs::write(&tmp, body)?;
    fs::rename(&tmp, &path)?;
    Ok(Some(path))
}

/// Ready spool files, oldest first (by the millisecond field in the name).
pub fn ready_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return vec![];
    };

    let mut files: Vec<(u128, PathBuf)> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "jsonl"))
        .map(|p| {
            let millis = p
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.split('-').find_map(|part| part.parse::<u128>().ok().filter(|n| *n > 1_000_000_000_000)))
                .unwrap_or(0);
            (millis, p)
        })
        .collect();

    files.sort();
    files.into_iter().map(|(_, p)| p).collect()
}

pub struct Batch {
    pub files: Vec<PathBuf>,
    pub events: Vec<Value>,
    /// Lines that were not valid JSON (dropped, reported in the log).
    pub invalid_lines: usize,
}

/// Reads whole files, oldest first, until `max_events` is reached (at least
/// one file is always taken so an oversized file can't block the queue).
pub fn read_batch(dir: &Path, max_events: usize) -> Batch {
    let mut batch = Batch { files: vec![], events: vec![], invalid_lines: 0 };

    for path in ready_files(dir) {
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let events: Vec<Value> = text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| match serde_json::from_str::<Value>(l) {
                Ok(v) if v.is_object() => Some(v),
                _ => {
                    batch.invalid_lines += 1;
                    None
                }
            })
            .collect();

        if !batch.files.is_empty() && batch.events.len() + events.len() > max_events {
            break;
        }
        batch.events.extend(events);
        batch.files.push(path);
    }

    batch
}

pub fn stats(dir: &Path) -> (usize, u64) {
    let files = ready_files(dir);
    let bytes = files.iter().filter_map(|p| fs::metadata(p).ok()).map(|m| m.len()).sum();
    (files.len(), bytes)
}

pub fn purge(dir: &Path) -> io::Result<usize> {
    let mut removed = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.to_string_lossy();
            if name.ends_with(".jsonl") || name.ends_with(".jsonl.tmp") {
                fs::remove_file(&path)?;
                removed += 1;
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
pub fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-{}-{}-{}", name, std::process::id(), crate::models::event_id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn write_and_read_back_in_order() {
        let dir = temp_dir("spool");
        write_events(&dir, "monitor", &[json!({"id": "a"}), json!({"id": "b"})]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        write_events(&dir, "cursor-ext", &[json!({"id": "c"})]).unwrap();
        fs::write(dir.join("half.jsonl.tmp"), "{\"id\":").unwrap();
        fs::write(dir.join("cursor-hook-9999999999999-1-0.jsonl"), "{\"id\":\"z\"}\nnot json\n").unwrap();

        let batch = read_batch(&dir, 100);
        let ids: Vec<&str> = batch.events.iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["a", "b", "c", "z"]);
        assert_eq!(batch.invalid_lines, 1);
        assert_eq!(batch.files.len(), 3);

        // Batch size limit is respected per file.
        assert_eq!(read_batch(&dir, 2).events.len(), 2);

        assert_eq!(purge(&dir).unwrap(), 4);
        assert_eq!(stats(&dir), (0, 0));
        fs::remove_dir_all(dir).ok();
    }
}
