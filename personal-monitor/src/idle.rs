//! Detects when the user is away, from the time since the last keyboard or
//! mouse input (GetLastInputInfo). Which keys were pressed is never read.

use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

/// Seconds since the last user input, or None if unavailable.
pub fn seconds_since_input() -> Option<u64> {
    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if !GetLastInputInfo(&mut info).as_bool() {
            return None;
        }
        let now = GetTickCount();
        Some(now.wrapping_sub(info.dwTime) as u64 / 1000)
    }
}

#[derive(Debug, PartialEq)]
pub enum IdleChange {
    /// The user went idle; the value is when (Unix seconds) input stopped.
    Started(i64),
    /// The user came back after `idle_seconds`.
    Ended { idle_seconds: u64 },
}

pub struct IdleTracker {
    threshold: u64,
    idle_since: Option<i64>,
}

impl IdleTracker {
    pub fn new(threshold: u64) -> Self {
        IdleTracker { threshold, idle_since: None }
    }

    pub fn update(&mut self, now: i64, seconds_idle: u64) -> Option<IdleChange> {
        match self.idle_since {
            None if seconds_idle >= self.threshold => {
                let since = now - seconds_idle as i64;
                self.idle_since = Some(since);
                Some(IdleChange::Started(since))
            }
            Some(since) if seconds_idle < self.threshold => {
                self.idle_since = None;
                Some(IdleChange::Ended {
                    idle_seconds: (now - seconds_idle as i64 - since).max(0) as u64,
                })
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_start_and_end() {
        let mut t = IdleTracker::new(120);
        assert_eq!(t.update(1000, 30), None);
        assert_eq!(t.update(1100, 130), Some(IdleChange::Started(970)));
        assert_eq!(t.update(1200, 230), None);
        assert_eq!(t.update(1300, 1), Some(IdleChange::Ended { idle_seconds: 329 }));
        assert_eq!(t.update(1301, 2), None);
    }
}
