//! Host, port, and scan checks.
//!
//! These rules are the Rust copy of `lib/hosts.js`. Change both together.
//! A label like `001` is rejected because some `ping` builds treat it as octal.

const MAX_HOST_LENGTH: usize = 253;

pub fn is_safe_host(host: &str) -> bool {
    if host.is_empty() || host.len() > MAX_HOST_LENGTH {
        return false;
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.iter().any(|label| label.is_empty()) {
        return false;
    }
    let ipv4 = labels.len() == 4 && labels.iter().copied().all(is_octet_label);
    let hostname = labels.iter().copied().all(is_hostname_label);
    if !ipv4 && !hostname {
        return false;
    }
    !labels.iter().copied().any(is_leading_zero_numeric)
}

pub fn is_safe_base_ip(base_ip: &str) -> bool {
    let labels: Vec<&str> = base_ip.split('.').collect();
    labels.len() == 3 && labels.iter().copied().all(is_octet_label)
}

pub fn is_safe_port(port: i64) -> bool {
    (1..=65535).contains(&port)
}

pub fn clamp_scan_range(start: i64, end: i64) -> Option<(i64, i64)> {
    if !(1..=254).contains(&start) || !(1..=254).contains(&end) || start > end {
        return None;
    }
    Some((start, end))
}

pub fn ping_args(host: &str, windows: bool) -> Vec<String> {
    if windows {
        vec![
            "-n".to_string(),
            "1".to_string(),
            "-w".to_string(),
            "1000".to_string(),
            host.to_string(),
        ]
    } else {
        vec![
            "-c".to_string(),
            "1".to_string(),
            "-W".to_string(),
            "1".to_string(),
            host.to_string(),
        ]
    }
}

pub fn monitoring_interval(requested: Option<f64>) -> u64 {
    match requested {
        Some(value) if value.is_finite() && (1000.0..=60_000.0).contains(&value) => value as u64,
        _ => 2000,
    }
}

pub fn is_reasonable_username(username: &str) -> bool {
    !username.is_empty()
        && username.len() <= 128
        && !username
            .bytes()
            .any(|byte| byte == b'\0' || byte == b'\r' || byte == b'\n')
}

fn is_octet_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    match bytes.len() {
        1 => bytes[0].is_ascii_digit(),
        2 => bytes[0].is_ascii_digit() && bytes[1].is_ascii_digit() && bytes[0] != b'0',
        3 => {
            bytes.iter().all(|byte| byte.is_ascii_digit()) && {
                let value = label.parse::<u16>().unwrap_or(256);
                (100..=255).contains(&value)
            }
        }
        _ => false,
    }
}

fn is_hostname_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    if bytes.is_empty() || bytes.len() > 63 || !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    if bytes.len() == 1 {
        return true;
    }
    bytes[bytes.len() - 1].is_ascii_alphanumeric()
        && bytes[1..bytes.len() - 1]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

fn is_leading_zero_numeric(label: &str) -> bool {
    let bytes = label.as_bytes();
    bytes.len() >= 2 && bytes[0] == b'0' && bytes.iter().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ipv4_and_hostnames() {
        assert!(is_safe_host("192.168.1.1"));
        assert!(is_safe_host("8.8.8.8"));
        assert!(is_safe_host("gateway.local"));
        assert!(is_safe_host("a"));
        assert!(is_safe_host("0.0.0.0"));
    }

    #[test]
    fn rejects_shell_metacharacters_and_octal_looking_labels() {
        assert!(!is_safe_host("192.168.1.1;id"));
        assert!(!is_safe_host("8.8.8.8 && whoami"));
        assert!(!is_safe_host("$(reboot)"));
        assert!(!is_safe_host("host`id`"));
        assert!(!is_safe_host(""));
        assert!(!is_safe_host("192.168.001.1"));
        assert!(!is_safe_host("192.168.00.1"));
    }

    #[test]
    fn accepts_a_three_octet_base_only() {
        assert!(is_safe_base_ip("192.168.1"));
        assert!(is_safe_base_ip("10.0.0"));
        assert!(!is_safe_base_ip("192.168.1.1"));
        assert!(!is_safe_base_ip("192.168.001"));
        assert!(!is_safe_base_ip("192.168.1;id"));
        assert!(!is_safe_base_ip("192.168"));
    }

    #[test]
    fn validates_ports_and_scan_bounds() {
        assert!(is_safe_port(22));
        assert!(is_safe_port(65535));
        assert!(!is_safe_port(0));
        assert!(!is_safe_port(65536));
        assert_eq!(clamp_scan_range(1, 254), Some((1, 254)));
        assert_eq!(clamp_scan_range(10, 2), None);
        assert_eq!(clamp_scan_range(0, 10), None);
        assert_eq!(clamp_scan_range(1, 255), None);
    }

    #[test]
    fn builds_ping_arguments_without_a_shell() {
        assert_eq!(
            ping_args("192.168.1.1", false),
            ["-c", "1", "-W", "1", "192.168.1.1"]
        );
        assert_eq!(
            ping_args("10.0.0.1", true),
            ["-n", "1", "-w", "1000", "10.0.0.1"]
        );
    }

    #[test]
    fn clamps_the_monitoring_interval() {
        assert_eq!(monitoring_interval(Some(2000.0)), 2000);
        assert_eq!(monitoring_interval(Some(50.0)), 2000);
        assert_eq!(monitoring_interval(None), 2000);
        assert_eq!(monitoring_interval(Some(60_000.0)), 60_000);
        assert_eq!(monitoring_interval(Some(f64::NAN)), 2000);
    }
}
