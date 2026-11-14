//! What an exported image may contain and where it may be written.
//! No Tauri here, so the rules are tested on their own.

use std::path::{Path, PathBuf};

pub const MAX_IMAGE_BYTES: usize = 96 * 1024 * 1024;
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Png,
    Svg,
}

impl Format {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "png" => Ok(Self::Png),
            "svg" => Ok(Self::Svg),
            _ => Err("Image format must be png or svg".to_string()),
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Svg => "svg",
        }
    }

    pub fn filter_name(self) -> &'static str {
        match self {
            Self::Png => "PNG Image",
            Self::Svg => "SVG Image",
        }
    }
}

/// Checks that the bytes really are the announced format. An SVG must be
/// UTF-8, start with an SVG root and carry no script or event handler.
pub fn validate_payload(format: Format, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("The image is empty".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("The image is too large".to_string());
    }
    match format {
        Format::Png => {
            if bytes.starts_with(PNG_MAGIC) {
                Ok(())
            } else {
                Err("The data is not a PNG image".to_string())
            }
        }
        Format::Svg => {
            let text = std::str::from_utf8(bytes).map_err(|_| "The SVG is not UTF-8".to_string())?;
            let body = text.trim_start_matches('\u{feff}').trim_start();
            let body = match body.strip_prefix("<?xml") {
                Some(rest) => match rest.find("?>") {
                    Some(end) => rest[end + 2..].trim_start(),
                    None => return Err("The SVG header is malformed".to_string()),
                },
                None => body,
            };
            if !body.starts_with("<svg") {
                return Err("The data is not an SVG image".to_string());
            }
            let lower = text.to_ascii_lowercase();
            if lower.contains("<script")
                || contains_in_tag(&lower, "javascript:")
                || lower.contains("<foreignobject")
                || has_event_attribute(&lower)
            {
                return Err("The SVG contains active content".to_string());
            }
            Ok(())
        }
    }
}

// " onload=", "\ton=" ... : an attribute name starting with "on".
fn has_event_attribute(lower: &str) -> bool {
    let bytes = lower.as_bytes();
    let mut index = 0;
    while let Some(found) = lower[index..].find("on") {
        let at = index + found;
        let before_ok = at > 0 && bytes[at - 1].is_ascii_whitespace();
        if before_ok {
            let mut end = at + 2;
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'-') {
                end += 1;
            }
            let mut next = end;
            while next < bytes.len() && bytes[next].is_ascii_whitespace() {
                next += 1;
            }
            if end > at + 2 && next < bytes.len() && bytes[next] == b'=' && inside_tag(lower, at) {
                return true;
            }
        }
        index = at + 2;
    }
    false
}

// A needle inside markup, not in text content (a node may be named anything).
fn contains_in_tag(lower: &str, needle: &str) -> bool {
    lower
        .match_indices(needle)
        .any(|(at, _)| inside_tag(lower, at))
}

// True when the position sits between a '<' and its '>' (not in text content).
fn inside_tag(lower: &str, at: usize) -> bool {
    let head = &lower[..at];
    match (head.rfind('<'), head.rfind('>')) {
        (Some(open), Some(close)) => open > close,
        (Some(_), None) => true,
        _ => false,
    }
}

/// The path the dialog returned, with the format's extension. A path with no
/// or another extension gets it appended, unless that would silently replace
/// a file the user never saw in the dialog.
pub fn checked_path(path: &Path, format: Format) -> Result<PathBuf, String> {
    let wanted = format.extension();
    let matches = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(wanted));
    if matches {
        return Ok(path.to_path_buf());
    }
    if path.file_name().is_none() {
        return Err("No file name was chosen".to_string());
    }
    let mut name = path.as_os_str().to_os_string();
    name.push(".");
    name.push(wanted);
    let extended = PathBuf::from(name);
    if extended.exists() {
        return Err(format!(
            "{} already exists; choose a name ending in .{wanted}",
            extended.display()
        ));
    }
    Ok(extended)
}

/// File name suggested in the dialog: a plain name with the right extension.
pub fn suggested_name(requested: Option<&str>, format: Format) -> String {
    let fallback = format!("topology.{}", format.extension());
    let Some(requested) = requested else {
        return fallback;
    };
    let clean: String = requested
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
        .take(100)
        .collect();
    let stem = clean.trim().trim_start_matches('.');
    let stem = Path::new(stem)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("")
        .trim();
    if stem.is_empty() {
        fallback
    } else {
        format!("{stem}.{}", format.extension())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_png_and_svg_are_accepted() {
        assert_eq!(Format::parse("png"), Ok(Format::Png));
        assert_eq!(Format::parse("svg"), Ok(Format::Svg));
        assert!(Format::parse("json").is_err());
        assert!(Format::parse("PNG ").is_err());
    }

    #[test]
    fn png_needs_its_signature() {
        let mut png = PNG_MAGIC.to_vec();
        png.extend_from_slice(b"rest");
        assert!(validate_payload(Format::Png, &png).is_ok());
        assert!(validate_payload(Format::Png, b"<svg></svg>").is_err());
        assert!(validate_payload(Format::Png, b"").is_err());
    }

    #[test]
    fn svg_must_be_a_passive_svg_document() {
        let good = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"><text>on = off</text></svg>";
        assert!(validate_payload(Format::Svg, good.as_bytes()).is_ok());
        assert!(validate_payload(Format::Svg, b"<svg><g class=\"nodes\"/></svg>").is_ok());
        assert!(validate_payload(Format::Svg, b"<html><svg/></html>").is_err());
        assert!(validate_payload(Format::Svg, b"<svg><script>x</script></svg>").is_err());
        assert!(validate_payload(Format::Svg, b"<svg onload=\"x()\"></svg>").is_err());
        assert!(validate_payload(Format::Svg, b"<svg><rect\n  onClick = \"x\"/></svg>").is_err());
        assert!(validate_payload(Format::Svg, b"<svg><a href=\"javascript:x\"/></svg>").is_err());
        assert!(validate_payload(Format::Svg, b"<svg><text>javascript: notes</text></svg>").is_ok());
        assert!(validate_payload(Format::Svg, b"<svg><foreignObject/></svg>").is_err());
        assert!(validate_payload(Format::Svg, &[0xff, 0xfe, 0x00]).is_err());
    }

    #[test]
    fn the_extension_is_enforced() {
        let directory = std::env::temp_dir().join(format!("topology-export-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let png = directory.join("map.PNG");
        assert_eq!(checked_path(&png, Format::Png).unwrap(), png);
        assert_eq!(
            checked_path(&directory.join("map"), Format::Svg).unwrap(),
            directory.join("map.svg")
        );
        assert_eq!(
            checked_path(&directory.join("map.exe"), Format::Png).unwrap(),
            directory.join("map.exe.png")
        );
        std::fs::write(directory.join("taken.png"), b"x").unwrap();
        assert!(checked_path(&directory.join("taken"), Format::Png).is_err());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn suggested_names_are_plain() {
        assert_eq!(suggested_name(Some("topology-2026-11-14.png"), Format::Png), "topology-2026-11-14.png");
        assert_eq!(suggested_name(Some("../../etc/passwd"), Format::Svg), "etcpasswd.svg");
        assert_eq!(suggested_name(Some("x.png"), Format::Svg), "x.svg");
        assert_eq!(suggested_name(Some(""), Format::Png), "topology.png");
        assert_eq!(suggested_name(None, Format::Svg), "topology.svg");
    }
}
