//! Topology image export. The renderer sends the encoded image; the path
//! always comes from the native save dialog, limited to .png or .svg.

mod rules;

use std::io::Write;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use rules::Format;

// Async so the blocking save dialog does not run on the main thread.
#[tauri::command]
pub async fn image_export(
    app: AppHandle,
    format: String,
    data: String,
    file_name: Option<String>,
) -> Value {
    let format = match Format::parse(&format) {
        Ok(format) => format,
        Err(error) => return failure(&error),
    };
    if data.len() > rules::MAX_IMAGE_BYTES / 3 * 4 + 4 {
        return failure("The image is too large");
    }
    let bytes = match STANDARD.decode(data.as_bytes()) {
        Ok(bytes) => bytes,
        Err(_) => return failure("The image data is not valid base64"),
    };
    if let Err(error) = rules::validate_payload(format, &bytes) {
        return failure(&error);
    }
    let picked = app
        .dialog()
        .file()
        .set_title("Export Topology Image")
        .set_file_name(rules::suggested_name(file_name.as_deref(), format))
        .add_filter(format.filter_name(), &[format.extension()])
        .blocking_save_file();
    let Some(path) = picked.and_then(|path| path.into_path().ok()) else {
        return json!({ "success": false, "canceled": true });
    };
    let path = match rules::checked_path(&path, format) {
        Ok(path) => path,
        Err(error) => return failure(&error),
    };
    match write_file(&path, &bytes) {
        Ok(()) => json!({ "success": true, "path": path.display().to_string() }),
        Err(error) => failure(&error),
    }
}

// Temporary file beside the target, then rename: a failed write never leaves
// half an image in place of an existing one.
fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "The chosen path has no directory".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("topology-image");
    let temporary = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));
    let written = std::fs::File::create(&temporary)
        .and_then(|mut file| {
            file.write_all(bytes)?;
            file.sync_all()
        })
        .and_then(|()| std::fs::rename(&temporary, path));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

fn failure(error: &str) -> Value {
    json!({ "success": false, "error": error })
}
