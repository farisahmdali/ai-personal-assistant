//! Delivers spooled events from all collectors to n8n's Activity Ingest
//! webhook. Files are removed only after a 2xx response; on failure the files
//! stay and delivery is retried with exponential backoff. Event ids are stable,
//! so a retry after a lost response is ignored as a duplicate by n8n.

use crate::{config, log, models, spool};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

pub trait Sender {
    fn send(&self, body: &str) -> Result<(), String>;
}

pub struct HttpSender {
    url: String,
    agent: ureq::Agent,
}

impl HttpSender {
    pub fn new(n8n_url: &str) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .build()
            .into();
        HttpSender {
            url: format!("{}/webhook/activity", n8n_url.trim_end_matches('/')),
            agent,
        }
    }
}

impl Sender for HttpSender {
    fn send(&self, body: &str) -> Result<(), String> {
        self.agent
            .post(&self.url)
            .header("Content-Type", "application/json")
            .send(body)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

pub enum Outcome {
    Idle,
    Delivered(usize),
    Failed(String),
}

pub struct Forwarder<S: Sender> {
    pub dir: PathBuf,
    pub sender: S,
    pub batch_size: usize,
}

impl<S: Sender> Forwarder<S> {
    /// Sends one batch. Returns what happened; never deletes undelivered files.
    pub fn deliver_once(&self) -> Outcome {
        let batch = spool::read_batch(&self.dir, self.batch_size);
        if batch.files.is_empty() {
            return Outcome::Idle;
        }
        if batch.invalid_lines > 0 {
            log::warn("spool_invalid_lines", json!({ "count": batch.invalid_lines }));
        }

        if !batch.events.is_empty() {
            let body = json!({ "events": batch.events }).to_string();
            if let Err(err) = self.sender.send(&body) {
                return Outcome::Failed(err);
            }
        }

        for file in &batch.files {
            if let Err(err) = fs::remove_file(file) {
                log::warn("spool_remove_failed", json!({ "file": file.to_string_lossy(), "error": err.to_string() }));
            }
        }
        Outcome::Delivered(batch.events.len())
    }
}

fn write_state(delivered: u64, last_delivery: Option<i64>, last_error: Option<&str>) {
    let state = json!({
        "delivered": delivered,
        "lastDeliveryAt": last_delivery.map(models::iso8601),
        "lastError": last_error,
        "updatedAt": models::iso8601(models::now_secs())
    });
    let _ = fs::write(config::state_path(), state.to_string());
}

/// Runs forever on its own thread.
pub fn run(n8n_url: String, batch_size: usize) {
    let forwarder = Forwarder {
        dir: config::spool_dir(),
        sender: HttpSender::new(&n8n_url),
        batch_size,
    };

    let mut backoff = 5u64;
    let mut delivered = 0u64;
    let mut last_delivery = None;

    loop {
        match forwarder.deliver_once() {
            Outcome::Idle => std::thread::sleep(Duration::from_secs(5)),
            Outcome::Delivered(n) => {
                delivered += n as u64;
                last_delivery = Some(models::now_secs());
                backoff = 5;
                log::info("delivered", json!({ "events": n }));
                write_state(delivered, last_delivery, None);
            }
            Outcome::Failed(err) => {
                log::warn("delivery_failed", json!({ "error": err, "retryInSeconds": backoff }));
                write_state(delivered, last_delivery, Some(&err));
                std::thread::sleep(Duration::from_secs(backoff));
                backoff = (backoff * 2).min(300);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct FakeSender {
        ok: bool,
        bodies: RefCell<Vec<String>>,
    }

    impl Sender for FakeSender {
        fn send(&self, body: &str) -> Result<(), String> {
            self.bodies.borrow_mut().push(body.to_string());
            if self.ok { Ok(()) } else { Err("connection refused".into()) }
        }
    }

    #[test]
    fn keeps_files_until_delivered() {
        let dir = spool::temp_dir("fwd");
        spool::write_events(&dir, "cursor-ext", &[json!({"id": "1"}), json!({"id": "2"})]).unwrap();

        let down = Forwarder { dir: dir.clone(), sender: FakeSender { ok: false, bodies: RefCell::new(vec![]) }, batch_size: 200 };
        assert!(matches!(down.deliver_once(), Outcome::Failed(_)));
        assert!(matches!(down.deliver_once(), Outcome::Failed(_)));
        assert_eq!(spool::stats(&dir).0, 1, "files must survive failed deliveries");

        // Same event ids are sent on every retry.
        let bodies = down.sender.bodies.borrow();
        assert_eq!(bodies[0], bodies[1]);
        drop(bodies);

        let up = Forwarder { dir: dir.clone(), sender: FakeSender { ok: true, bodies: RefCell::new(vec![]) }, batch_size: 200 };
        assert!(matches!(up.deliver_once(), Outcome::Delivered(2)));
        assert!(matches!(up.deliver_once(), Outcome::Idle));
        let sent: serde_json::Value = serde_json::from_str(&up.sender.bodies.borrow()[0]).unwrap();
        assert_eq!(sent["events"][1]["id"], "2");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn unreachable_n8n_is_a_failure_not_a_loss() {
        let dir = spool::temp_dir("fwd-http");
        spool::write_events(&dir, "monitor", &[json!({"id": "x"})]).unwrap();
        let f = Forwarder { dir: dir.clone(), sender: HttpSender::new("http://127.0.0.1:9"), batch_size: 200 };
        assert!(matches!(f.deliver_once(), Outcome::Failed(_)));
        assert_eq!(spool::stats(&dir).0, 1);
        fs::remove_dir_all(dir).ok();
    }
}
