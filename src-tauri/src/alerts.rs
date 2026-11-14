//! Desktop notifications for state-change alerts.
//!
//! The renderer (`renderer/js/alerts.js`) decides when to alert; this command
//! only shows the notification through `tauri-plugin-notification`, which uses
//! the native notification service on each desktop platform.

use tauri_plugin_notification::NotificationExt;

const TITLE_LIMIT: usize = 120;
const BODY_LIMIT: usize = 400;

#[tauri::command]
pub fn alerts_notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    let title = clip(&title, TITLE_LIMIT);
    if title.is_empty() {
        return Err("Notification has no title".to_string());
    }
    app.notification()
        .builder()
        .title(title)
        .body(clip(&body, BODY_LIMIT))
        .show()
        .map_err(|error| error.to_string())
}

fn clip(text: &str, limit: usize) -> String {
    let clean: String = text.chars().filter(|c| !c.is_control()).collect();
    let trimmed = clean.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let mut cut: String = trimmed.chars().take(limit.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::clip;

    #[test]
    fn clip_trims_strips_controls_and_shortens() {
        assert_eq!(clip("  nas is down\n", 50), "nas is down");
        assert_eq!(clip("abcdef", 4), "abc…");
        assert_eq!(clip("\u{7}", 4), "");
    }
}
