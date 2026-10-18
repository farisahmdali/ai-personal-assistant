use serde::Serialize;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
pub struct ActivityEvent {
    pub timestamp: i64,
    pub event_type: String,
    pub application: String,
    pub window_title: Option<String>,
}

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Unique, stable id for an event, generated once at capture time so retried
/// deliveries are recognised as duplicates by n8n.
pub fn event_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("mon-{:x}-{:x}-{}", nanos, std::process::id(), seq)
}

/// The shared event envelope used by every collector:
/// `{ id, ts, source, type, project, data }`.
pub fn envelope(event_type: &str, unix_secs: i64, data: Value) -> Value {
    json!({
        "id": event_id(),
        "ts": iso8601(unix_secs),
        "source": "monitor",
        "type": event_type,
        "project": null,
        "data": data
    })
}

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Formats Unix seconds as an RFC 3339 UTC timestamp.
pub fn iso8601(unix_secs: i64) -> String {
    let days = unix_secs.div_euclid(86_400);
    let secs = unix_secs.rem_euclid(86_400);

    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month,
        day,
        secs / 3_600,
        (secs % 3_600) / 60,
        secs % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_timestamps() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_791_348_367), "2026-10-07T04:46:07Z");
        assert_eq!(iso8601(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn ids_are_unique() {
        let ids: std::collections::HashSet<String> = (0..1000).map(|_| event_id()).collect();
        assert_eq!(ids.len(), 1000);
    }
}
