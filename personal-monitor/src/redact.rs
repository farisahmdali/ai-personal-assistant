//! Removes secret-looking tokens from window titles (titles can contain URLs
//! or file contents). Mirrors the main patterns of cursor-activity/lib/redact.js.

const PREFIXES: &[&str] = &["sk-", "ghp_", "gho_", "ghu_", "ghs_", "github_pat_", "xoxb-", "xoxp-", "AKIA", "AIza", "eyJ"];
const SECRET_NAMES: &[&str] = &["password", "passwd", "secret", "token", "apikey", "api_key", "api-key"];

fn is_secret(token: &str) -> bool {
    let bare = token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-');
    if PREFIXES.iter().any(|p| bare.starts_with(p)) && bare.len() >= 16 {
        return true;
    }
    if let Some((name, value)) = bare.split_once('=') {
        let name = name.to_ascii_lowercase();
        return SECRET_NAMES.iter().any(|s| name.contains(s)) && !value.is_empty();
    }
    false
}

pub fn redact(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for token in text.split(' ') {
        if is_secret(token) {
            out.push("[REDACTED]".into());
        } else if let Some(at) = token.find('@').filter(|_| token.contains("://")) {
            // scheme://user:password@host
            let (creds, host) = token.split_at(at);
            match creds.rsplit_once(':') {
                Some((user, _)) if user.contains("://") && !user.ends_with("//") => {
                    out.push(format!("{}:[REDACTED]{}", user, host))
                }
                _ => out.push(token.into()),
            }
        } else {
            out.push(token.into());
        }
    }
    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_tokens_in_titles() {
        assert_eq!(redact("main.rs - personal-monitor - Cursor"), "main.rs - personal-monitor - Cursor");
        assert_eq!(redact("key sk-or-v1-0123456789abcdef0123 - Notepad"), "key [REDACTED] - Notepad");
        assert_eq!(redact("PASSWORD=hunter2 - cmd"), "[REDACTED] - cmd");
        assert_eq!(redact("postgres://app:pw@localhost/db - pgAdmin"), "postgres://app:[REDACTED]@localhost/db - pgAdmin");
    }
}
