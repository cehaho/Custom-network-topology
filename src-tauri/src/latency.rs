//! Round-trip time read from the output of `ping`.
//!
//! Pure text parsing, no I/O, so it can be tested on any platform. The reply
//! line is looked for in the output of one echo request:
//!
//! - Linux / macOS / BSD: `64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms`
//! - Windows (English): `Reply from 8.8.8.8: bytes=32 time=12ms TTL=117`,
//!   or `time<1ms` for a sub-millisecond reply
//! - Windows (French): `Réponse de 8.8.8.8 : octets=32 temps=12 ms TTL=117`,
//!   or `temps<1ms`
//! - Windows (German / Spanish / Italian / Portuguese): `Zeit=`, `tiempo=`,
//!   `tempo=`
//!
//! A `<N` value (Windows only reports whole milliseconds) is returned as half
//! of `N`, so `<1ms` becomes `0.5`. The summary lines (`time 0ms`,
//! `Average = 12ms`) are not used: the reply line is enough for one request.

const KEYWORDS: [&[u8]; 5] = [b"time", b"temps", b"zeit", b"tiempo", b"tempo"];

/// Round-trip time in milliseconds of the first reply in `output`, or `None`
/// when no reply line carries a time.
pub fn parse_ping_time(output: &str) -> Option<f64> {
    output.lines().find_map(parse_line)
}

fn parse_line(line: &str) -> Option<f64> {
    let lower = line.as_bytes().to_ascii_lowercase();
    let mut index = 0;
    while index < lower.len() {
        for keyword in KEYWORDS {
            if !lower[index..].starts_with(keyword) {
                continue;
            }
            // The keyword must start a word: `uptime=` is not a time.
            if index > 0 && lower[index - 1].is_ascii_alphanumeric() {
                continue;
            }
            if let Some(value) = parse_value(&lower[index + keyword.len()..]) {
                return Some(value);
            }
        }
        index += 1;
    }
    None
}

/// Reads `=12.3 ms`, `<1ms`, `= 4,2 ms` after the keyword.
fn parse_value(rest: &[u8]) -> Option<f64> {
    let rest = skip_spaces(rest);
    let (&sign, rest) = rest.split_first()?;
    let below = match sign {
        b'=' => false,
        b'<' => true,
        _ => return None,
    };
    let rest = skip_spaces(rest);
    let end = rest
        .iter()
        .position(|byte| !(byte.is_ascii_digit() || *byte == b'.' || *byte == b','))
        .unwrap_or(rest.len());
    if end == 0 || !rest[0].is_ascii_digit() {
        return None;
    }
    let text = std::str::from_utf8(&rest[..end]).ok()?.replace(',', ".");
    let text = text.trim_end_matches('.');
    let value: f64 = text.parse().ok()?;
    // A unit, when present, must be milliseconds.
    let unit = skip_spaces(&rest[end..]);
    if !unit.is_empty() && unit[0].is_ascii_alphabetic() && !unit.starts_with(b"ms") {
        return None;
    }
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    Some(if below { value / 2.0 } else { value })
}

fn skip_spaces(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    &bytes[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_iputils_reply() {
        let output = "PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.\n\
            64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms\n\
            \n\
            --- 1.1.1.1 ping statistics ---\n\
            1 packets transmitted, 1 received, 0% packet loss, time 0ms\n\
            rtt min/avg/max/mdev = 12.345/12.345/12.345/0.000 ms\n";
        assert_eq!(parse_ping_time(output), Some(12.3));
    }

    #[test]
    fn linux_ipv6_reply() {
        let output = "PING ::1(::1) 56 data bytes\n\
            64 bytes from ::1: icmp_seq=1 ttl=64 time=0.045 ms\n";
        assert_eq!(parse_ping_time(output), Some(0.045));
    }

    #[test]
    fn linux_timeout_has_no_time() {
        let output = "PING 10.9.9.9 (10.9.9.9) 56(84) bytes of data.\n\
            \n\
            --- 10.9.9.9 ping statistics ---\n\
            1 packets transmitted, 0 received, 100% packet loss, time 0ms\n";
        assert_eq!(parse_ping_time(output), None);
    }

    #[test]
    fn macos_reply() {
        let output = "PING 192.168.1.1 (192.168.1.1): 56 data bytes\n\
            64 bytes from 192.168.1.1: icmp_seq=0 ttl=64 time=3.712 ms\n\
            \n\
            --- 192.168.1.1 ping statistics ---\n\
            1 packets transmitted, 1 packets received, 0.0% packet loss\n\
            round-trip min/avg/max/stddev = 3.712/3.712/3.712/0.000 ms\n";
        assert_eq!(parse_ping_time(output), Some(3.712));
    }

    #[test]
    fn macos_timeout_has_no_time() {
        let output = "PING 10.9.9.9 (10.9.9.9): 56 data bytes\n\
            Request timeout for icmp_seq 0\n\
            \n\
            --- 10.9.9.9 ping statistics ---\n\
            2 packets transmitted, 0 packets received, 100.0% packet loss\n";
        assert_eq!(parse_ping_time(output), None);
    }

    #[test]
    fn windows_english_reply() {
        let output = "\r\nPinging 8.8.8.8 with 32 bytes of data:\r\n\
            Reply from 8.8.8.8: bytes=32 time=12ms TTL=117\r\n\
            \r\n\
            Ping statistics for 8.8.8.8:\r\n\
            \x20   Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),\r\n\
            Approximate round trip times in milli-seconds:\r\n\
            \x20   Minimum = 12ms, Maximum = 12ms, Average = 12ms\r\n";
        assert_eq!(parse_ping_time(output), Some(12.0));
    }

    #[test]
    fn windows_sub_millisecond_reply() {
        let output = "Pinging 192.168.1.1 with 32 bytes of data:\r\n\
            Reply from 192.168.1.1: bytes=32 time<1ms TTL=64\r\n";
        assert_eq!(parse_ping_time(output), Some(0.5));
    }

    #[test]
    fn windows_french_reply() {
        let output = "Envoi d’une requête 'Ping'  8.8.8.8 avec 32 octets de données :\r\n\
            Réponse de 8.8.8.8 : octets=32 temps=12 ms TTL=117\r\n\
            \r\n\
            Statistiques Ping pour 8.8.8.8:\r\n\
            \x20   Paquets : envoyés = 1, reçus = 1, perdus = 0 (perte 0%),\r\n\
            Durée approximative des boucles en millisecondes :\r\n\
            \x20   Minimum = 12ms, Maximum = 12ms, Moyenne = 12ms\r\n";
        assert_eq!(parse_ping_time(output), Some(12.0));
    }

    #[test]
    fn windows_french_sub_millisecond_reply() {
        let output = "Réponse de 192.168.1.1 : octets=32 temps<1ms TTL=64\r\n";
        assert_eq!(parse_ping_time(output), Some(0.5));
    }

    #[test]
    fn windows_german_reply() {
        let output = "Antwort von 8.8.8.8: Bytes=32 Zeit=15ms TTL=117\r\n";
        assert_eq!(parse_ping_time(output), Some(15.0));
    }

    #[test]
    fn windows_unreachable_has_no_time() {
        let output = "Pinging 10.0.0.9 with 32 bytes of data:\r\n\
            Reply from 10.0.0.1: Destination host unreachable.\r\n\
            Request timed out.\r\n";
        assert_eq!(parse_ping_time(output), None);
    }

    #[test]
    fn decimal_comma_and_spaces() {
        assert_eq!(parse_ping_time("temps = 4,25 ms"), Some(4.25));
    }

    #[test]
    fn ignores_words_that_only_contain_the_keyword() {
        assert_eq!(parse_ping_time("uptime=12 ms"), None);
        assert_eq!(parse_ping_time("time=12 s"), None);
        assert_eq!(parse_ping_time("time=abc"), None);
        assert_eq!(parse_ping_time(""), None);
    }
}
