//! Maps an executable name to an activity category. Add entries to extend.

const CATEGORIES: &[(&str, &[&str])] = &[
    ("coding", &["cursor.exe", "code.exe", "code - insiders.exe", "devenv.exe", "idea64.exe", "pycharm64.exe", "webstorm64.exe", "rustrover64.exe", "zed.exe", "sublime_text.exe", "notepad++.exe", "antigravity.exe"]),
    ("browser", &["chrome.exe", "msedge.exe", "firefox.exe", "opera.exe", "brave.exe", "vivaldi.exe", "arc.exe"]),
    ("terminal", &["windowsterminal.exe", "powershell.exe", "pwsh.exe", "cmd.exe", "wezterm-gui.exe", "alacritty.exe", "mintty.exe", "conhost.exe"]),
    ("communication", &["slack.exe", "teams.exe", "ms-teams.exe", "discord.exe", "outlook.exe", "olk.exe", "zoom.exe", "whatsapp.exe", "telegram.exe"]),
    ("notes", &["notion.exe", "obsidian.exe", "onenote.exe", "winword.exe", "excel.exe", "powerpnt.exe"]),
    ("design", &["figma.exe", "photoshop.exe", "illustrator.exe"]),
    ("database", &["pgadmin4.exe", "dbeaver.exe", "mongodbcompass.exe", "ssms.exe"]),
    ("system", &["explorer.exe", "searchhost.exe", "startmenuexperiencehost.exe", "shellexperiencehost.exe", "lockapp.exe", "taskmgr.exe", "systemsettings.exe"]),
];

pub fn categorize(application: &str) -> &'static str {
    let exe = application.to_ascii_lowercase();
    CATEGORIES
        .iter()
        .find(|(_, apps)| apps.contains(&exe.as_str()))
        .map(|(category, _)| *category)
        .unwrap_or("other")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_apps() {
        assert_eq!(categorize("Cursor.exe"), "coding");
        assert_eq!(categorize("chrome.exe"), "browser");
        assert_eq!(categorize("WindowsTerminal.exe"), "terminal");
        assert_eq!(categorize("explorer.exe"), "system");
        assert_eq!(categorize("game.exe"), "other");
    }
}
