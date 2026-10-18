mod classify;
mod config;
mod forwarder;
mod idle;
mod log;
mod models;
mod redact;
mod spool;

use models::ActivityEvent;

use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::ProcessStatus::GetModuleFileNameExW;
use windows::Win32::System::Threading::{
    OpenProcess,
    PROCESS_QUERY_INFORMATION,
    PROCESS_VM_READ,
};

use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow,
    GetWindowTextW,
    GetWindowThreadProcessId,
};

const USAGE: &str = "personal-monitor [run|init|pause|resume|status|purge-local]

  run          watch the active window and idle time, and deliver all
               collected activity (Cursor extension, hooks, this monitor)
               to n8n (default)
  init         create %LOCALAPPDATA%\\ai-assistant with a default config.json
  pause        stop capturing activity in all collectors
  resume       resume capturing
  status       show paused state, queued events and last delivery
  purge-local  delete all queued (undelivered) events";

fn main() {
    let command = std::env::args().nth(1).unwrap_or_else(|| "run".into());

    let result = match command.as_str() {
        "run" => {
            run();
            Ok(())
        }
        "init" => config::init().map(|p| println!("config: {}", p.display())),
        "pause" => config::set_paused(true).map(|_| println!("activity capture paused")),
        "resume" => config::set_paused(false).map(|_| println!("activity capture resumed")),
        "status" => {
            status();
            Ok(())
        }
        "purge-local" => spool::purge(&config::spool_dir()).map(|n| println!("deleted {} queued spool files", n)),
        _ => {
            println!("{}", USAGE);
            Ok(())
        }
    };

    if let Err(err) = result {
        eprintln!("error: {}", err);
        std::process::exit(1);
    }
}

fn status() {
    let (files, bytes) = spool::stats(&config::spool_dir());
    println!("data dir:  {}", config::data_dir().display());
    println!("paused:    {}", config::is_paused());
    println!("queued:    {} files, {} bytes", files, bytes);
    match std::fs::read_to_string(config::state_path()) {
        Ok(state) => println!("delivery:  {}", state),
        Err(_) => println!("delivery:  no deliveries yet"),
    }
}

fn record(event: serde_json::Value) {
    if config::is_paused() {
        return;
    }
    if let Err(err) = spool::write_events(&config::spool_dir(), "monitor", &[event]) {
        log::warn("spool_write_failed", json!({ "error": err.to_string() }));
    }
}

fn run() {
    let cfg = config::load();
    let _ = config::init();
    log::info("started", json!({ "n8nUrl": cfg.n8n_url, "version": env!("CARGO_PKG_VERSION") }));

    let url = cfg.n8n_url.clone();
    let batch_size = cfg.batch_size;
    std::thread::spawn(move || forwarder::run(url, batch_size));

    let mut previous_window = String::new();
    let mut idle_tracker = idle::IdleTracker::new(cfg.idle_seconds);

    loop {
        if let Some(activity) = get_active_window() {
            let current_window = activity.window_title.clone().unwrap_or_default();

            if current_window != previous_window {
                println!("{:?}", activity);

                let title = activity
                    .window_title
                    .as_deref()
                    .filter(|_| cfg.capture_window_titles)
                    .map(redact::redact);

                record(models::envelope(
                    "window_focus",
                    activity.timestamp,
                    json!({
                        "application": activity.application,
                        "category": classify::categorize(&activity.application),
                        "windowTitle": title
                    }),
                ));

                previous_window = current_window;
            }
        }

        if let Some(seconds_idle) = idle::seconds_since_input() {
            let now = models::now_secs();
            match idle_tracker.update(now, seconds_idle) {
                Some(idle::IdleChange::Started(since)) => {
                    record(models::envelope("idle_start", since, json!({ "thresholdSeconds": cfg.idle_seconds })));
                }
                Some(idle::IdleChange::Ended { idle_seconds }) => {
                    record(models::envelope("idle_end", now, json!({ "idleSeconds": idle_seconds })));
                }
                None => {}
            }
        }

        std::thread::sleep(
            std::time::Duration::from_millis(500)
        );
    }
}

fn get_active_window() -> Option<ActivityEvent> {
    unsafe {
        // 1. Get the currently focused window
        let hwnd = GetForegroundWindow();

        if hwnd.0.is_null() {
            return None;
        }

        // 2. Get window title
        let mut title_buffer = [0u16; 512];

        let title_length = GetWindowTextW(
            hwnd,
            &mut title_buffer,
        );

        let window_title = if title_length > 0 {
            Some(
                String::from_utf16_lossy(
                    &title_buffer[..title_length as usize]
                )
            )
        } else {
            None
        };

        // 3. Get Process ID
        let mut process_id = 0u32;

        GetWindowThreadProcessId(
            hwnd,
            Some(&mut process_id),
        );

        if process_id == 0 {
            return None;
        }

        // 4. Open the process
        let process_handle = OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
            false,
            process_id,
        );

        let process_handle = match process_handle {
            Ok(handle) => handle,
            Err(_) => {
                return None;
            }
        };

        // 5. Get executable name/path
        let mut process_buffer = [0u16; 512];

        let process_length = GetModuleFileNameExW(
            Some(process_handle),
            None,
            &mut process_buffer,
        );

        // We don't need the process handle anymore
        let _ = CloseHandle(process_handle);

        if process_length == 0 {
            return None;
        }

        let process_path = String::from_utf16_lossy(
            &process_buffer[..process_length as usize]
        );

        // 6. Extract just the executable name
        let application = process_path
            .rsplit('\\')
            .next()
            .unwrap_or(&process_path)
            .to_string();

        // 7. Timestamp
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        Some(ActivityEvent {
            timestamp,
            event_type: String::from("window_changed"),
            application,
            window_title,
        })
    }
}
