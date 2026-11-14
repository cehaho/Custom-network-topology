//! The small part of BER (X.690) that SNMPv2c messages use.
//!
//! Requests are GET, GETNEXT and GETBULK (RFC 3416). Only a Response PDU is
//! decoded. Lengths are definite. Anything malformed is an error, never a
//! panic: the bytes come from the network.

pub const VERSION_2C: i64 = 1;

const TAG_INTEGER: u8 = 0x02;
const TAG_OCTET_STRING: u8 = 0x04;
const TAG_NULL: u8 = 0x05;
const TAG_OID: u8 = 0x06;
const TAG_SEQUENCE: u8 = 0x30;
const TAG_IP_ADDRESS: u8 = 0x40;
const TAG_COUNTER32: u8 = 0x41;
const TAG_GAUGE32: u8 = 0x42;
const TAG_TIMETICKS: u8 = 0x43;
const TAG_OPAQUE: u8 = 0x44;
const TAG_COUNTER64: u8 = 0x46;
const TAG_NO_SUCH_OBJECT: u8 = 0x80;
const TAG_NO_SUCH_INSTANCE: u8 = 0x81;
const TAG_END_OF_MIB_VIEW: u8 = 0x82;
const TAG_GET: u8 = 0xA0;
const TAG_GET_NEXT: u8 = 0xA1;
const TAG_RESPONSE: u8 = 0xA2;
const TAG_GET_BULK: u8 = 0xA5;

const MAX_OID_ARCS: usize = 128;
const MAX_VARBINDS: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SnmpValue {
    Integer(i64),
    OctetString(Vec<u8>),
    Null,
    Oid(Vec<u32>),
    IpAddress([u8; 4]),
    Counter32(u32),
    Gauge32(u32),
    TimeTicks(u32),
    Opaque(Vec<u8>),
    Counter64(u64),
    NoSuchObject,
    NoSuchInstance,
    EndOfMibView,
    Other(u8),
}

impl SnmpValue {
    /// True for the three v2c exception values.
    pub fn is_exception(&self) -> bool {
        matches!(
            self,
            Self::NoSuchObject | Self::NoSuchInstance | Self::EndOfMibView
        )
    }

    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Self::Integer(value) => u64::try_from(*value).ok(),
            Self::Counter32(value) | Self::Gauge32(value) | Self::TimeTicks(value) => {
                Some(u64::from(*value))
            }
            Self::Counter64(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_text(&self) -> Option<String> {
        match self {
            Self::OctetString(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PduKind {
    Get,
    GetNext,
    GetBulk { non_repeaters: u32, max_repetitions: u32 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Response {
    pub version: i64,
    pub community: Vec<u8>,
    pub request_id: i64,
    pub error_status: i64,
    pub error_index: i64,
    pub varbinds: Vec<(Vec<u32>, SnmpValue)>,
}

/// Dotted text (`1.3.6.1.2.1.1.5.0`) to arcs. A leading dot is allowed.
pub fn parse_oid(text: &str) -> Option<Vec<u32>> {
    let trimmed = text.strip_prefix('.').unwrap_or(text);
    let arcs: Option<Vec<u32>> = trimmed.split('.').map(|arc| arc.parse().ok()).collect();
    let arcs = arcs?;
    valid_oid(&arcs).then_some(arcs)
}

fn valid_oid(arcs: &[u32]) -> bool {
    arcs.len() >= 2
        && arcs.len() <= MAX_OID_ARCS
        && arcs[0] <= 2
        && (arcs[0] == 2 || arcs[1] < 40)
        && arcs[1] <= u32::MAX - 80
}

pub fn encode_request(
    community: &[u8],
    request_id: i32,
    kind: PduKind,
    oids: &[Vec<u32>],
) -> Result<Vec<u8>, String> {
    if oids.is_empty() || oids.len() > MAX_VARBINDS {
        return Err("An SNMP request needs between 1 and 256 OIDs".to_string());
    }
    let mut varbinds = Vec::new();
    for oid in oids {
        let mut pair = encode_oid(oid)?;
        pair.extend(tlv(TAG_NULL, &[]));
        varbinds.extend(tlv(TAG_SEQUENCE, &pair));
    }
    let (tag, second, third) = match kind {
        PduKind::Get => (TAG_GET, 0, 0),
        PduKind::GetNext => (TAG_GET_NEXT, 0, 0),
        PduKind::GetBulk {
            non_repeaters,
            max_repetitions,
        } => (
            TAG_GET_BULK,
            i64::from(non_repeaters),
            i64::from(max_repetitions),
        ),
    };
    let mut pdu = encode_integer(i64::from(request_id));
    pdu.extend(encode_integer(second));
    pdu.extend(encode_integer(third));
    pdu.extend(tlv(TAG_SEQUENCE, &varbinds));
    let mut message = encode_integer(VERSION_2C);
    message.extend(tlv(TAG_OCTET_STRING, community));
    message.extend(tlv(tag, &pdu));
    Ok(tlv(TAG_SEQUENCE, &message))
}

pub fn decode_response(bytes: &[u8]) -> Result<Response, String> {
    let mut outer = Reader::new(bytes);
    let message = outer.expect(TAG_SEQUENCE)?;
    let mut message = Reader::new(message);
    let version = decode_signed(message.expect(TAG_INTEGER)?)?;
    let community = message.expect(TAG_OCTET_STRING)?.to_vec();
    let pdu = message.expect(TAG_RESPONSE)?;
    let mut pdu = Reader::new(pdu);
    let request_id = decode_signed(pdu.expect(TAG_INTEGER)?)?;
    let error_status = decode_signed(pdu.expect(TAG_INTEGER)?)?;
    let error_index = decode_signed(pdu.expect(TAG_INTEGER)?)?;
    let list = pdu.expect(TAG_SEQUENCE)?;
    let mut list = Reader::new(list);
    let mut varbinds = Vec::new();
    while !list.is_empty() {
        if varbinds.len() >= MAX_VARBINDS {
            return Err("SNMP response has too many values".to_string());
        }
        let mut pair = Reader::new(list.expect(TAG_SEQUENCE)?);
        let oid = decode_oid(pair.expect(TAG_OID)?)?;
        let (tag, content) = pair.next()?;
        varbinds.push((oid, decode_value(tag, content)?));
    }
    Ok(Response {
        version,
        community,
        request_id,
        error_status,
        error_index,
        varbinds,
    })
}

/// RFC 3416 error-status names, for messages.
pub fn error_name(status: i64) -> &'static str {
    match status {
        1 => "tooBig",
        2 => "noSuchName",
        3 => "badValue",
        4 => "readOnly",
        5 => "genErr",
        6 => "noAccess",
        16 => "authorizationError",
        _ => "error",
    }
}

fn decode_value(tag: u8, content: &[u8]) -> Result<SnmpValue, String> {
    Ok(match tag {
        TAG_INTEGER => SnmpValue::Integer(decode_signed(content)?),
        TAG_OCTET_STRING => SnmpValue::OctetString(content.to_vec()),
        TAG_NULL => SnmpValue::Null,
        TAG_OID => SnmpValue::Oid(decode_oid(content)?),
        TAG_IP_ADDRESS => {
            let octets: [u8; 4] = content
                .try_into()
                .map_err(|_| "SNMP IpAddress must be 4 bytes".to_string())?;
            SnmpValue::IpAddress(octets)
        }
        TAG_COUNTER32 => SnmpValue::Counter32(decode_u32(content)?),
        TAG_GAUGE32 => SnmpValue::Gauge32(decode_u32(content)?),
        TAG_TIMETICKS => SnmpValue::TimeTicks(decode_u32(content)?),
        TAG_OPAQUE => SnmpValue::Opaque(content.to_vec()),
        TAG_COUNTER64 => SnmpValue::Counter64(decode_unsigned(content)?),
        TAG_NO_SUCH_OBJECT => SnmpValue::NoSuchObject,
        TAG_NO_SUCH_INSTANCE => SnmpValue::NoSuchInstance,
        TAG_END_OF_MIB_VIEW => SnmpValue::EndOfMibView,
        other => SnmpValue::Other(other),
    })
}

fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len() + 6);
    out.push(tag);
    encode_length(content.len(), &mut out);
    out.extend_from_slice(content);
    out
}

fn encode_length(length: usize, out: &mut Vec<u8>) {
    if length < 0x80 {
        out.push(length as u8);
        return;
    }
    let bytes = length.to_be_bytes();
    let first = bytes.iter().position(|byte| *byte != 0).unwrap_or(bytes.len() - 1);
    let significant = &bytes[first..];
    out.push(0x80 | significant.len() as u8);
    out.extend_from_slice(significant);
}

fn encode_integer(value: i64) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    let mut start = 0;
    while start < bytes.len() - 1 {
        let current = bytes[start];
        let next_high_bit = bytes[start + 1] & 0x80;
        if (current == 0x00 && next_high_bit == 0) || (current == 0xFF && next_high_bit != 0) {
            start += 1;
        } else {
            break;
        }
    }
    tlv(TAG_INTEGER, &bytes[start..])
}

fn encode_oid(arcs: &[u32]) -> Result<Vec<u8>, String> {
    if !valid_oid(arcs) {
        return Err("Invalid SNMP OID".to_string());
    }
    let mut content = Vec::new();
    push_base128(arcs[0] * 40 + arcs[1], &mut content);
    for arc in &arcs[2..] {
        push_base128(*arc, &mut content);
    }
    Ok(tlv(TAG_OID, &content))
}

fn push_base128(value: u32, out: &mut Vec<u8>) {
    let mut groups = [0u8; 5];
    let mut count = 0;
    let mut rest = value;
    loop {
        groups[count] = (rest & 0x7F) as u8;
        count += 1;
        rest >>= 7;
        if rest == 0 {
            break;
        }
    }
    for index in (0..count).rev() {
        let continuation = if index == 0 { 0 } else { 0x80 };
        out.push(groups[index] | continuation);
    }
}

fn decode_oid(content: &[u8]) -> Result<Vec<u32>, String> {
    if content.is_empty() {
        return Err("Empty SNMP OID".to_string());
    }
    let mut values = Vec::new();
    let mut current: u32 = 0;
    let mut in_progress = false;
    for byte in content {
        if !in_progress && *byte == 0x80 {
            return Err("SNMP OID has a padded arc".to_string());
        }
        current = current
            .checked_mul(128)
            .and_then(|value| value.checked_add(u32::from(byte & 0x7F)))
            .ok_or_else(|| "SNMP OID arc is too large".to_string())?;
        if byte & 0x80 == 0 {
            values.push(current);
            current = 0;
            in_progress = false;
            if values.len() > MAX_OID_ARCS {
                return Err("SNMP OID is too long".to_string());
            }
        } else {
            in_progress = true;
        }
    }
    if in_progress {
        return Err("SNMP OID ends inside an arc".to_string());
    }
    let first = values[0];
    let mut arcs = Vec::with_capacity(values.len() + 1);
    match first {
        0..=39 => arcs.extend([0, first]),
        40..=79 => arcs.extend([1, first - 40]),
        _ => arcs.extend([2, first - 80]),
    }
    arcs.extend_from_slice(&values[1..]);
    Ok(arcs)
}

fn decode_signed(content: &[u8]) -> Result<i64, String> {
    if content.is_empty() || content.len() > 8 {
        return Err("SNMP integer has a bad length".to_string());
    }
    let mut value: i64 = if content[0] & 0x80 != 0 { -1 } else { 0 };
    for byte in content {
        value = (value << 8) | i64::from(*byte);
    }
    Ok(value)
}

fn decode_unsigned(content: &[u8]) -> Result<u64, String> {
    if content.is_empty() || content.len() > 9 || (content.len() == 9 && content[0] != 0) {
        return Err("SNMP counter has a bad length".to_string());
    }
    // Some agents send a counter with the high bit set and no leading zero.
    // Read every unsigned type as plain big-endian bytes.
    let mut value: u64 = 0;
    for byte in content {
        value = (value << 8) | u64::from(*byte);
    }
    Ok(value)
}

fn decode_u32(content: &[u8]) -> Result<u32, String> {
    let value = decode_unsigned(content)?;
    u32::try_from(value).map_err(|_| "SNMP 32-bit value is too large".to_string())
}

struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }

    fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    fn next(&mut self) -> Result<(u8, &'a [u8]), String> {
        let truncated = || "SNMP message is truncated".to_string();
        let tag = *self.bytes.first().ok_or_else(truncated)?;
        if tag & 0x1F == 0x1F {
            return Err("SNMP message uses an unsupported tag".to_string());
        }
        let first = *self.bytes.get(1).ok_or_else(truncated)?;
        let (length, header) = if first < 0x80 {
            (usize::from(first), 2)
        } else {
            let count = usize::from(first & 0x7F);
            if count == 0 || count > 4 {
                return Err("SNMP message has an unsupported length".to_string());
            }
            let digits = self.bytes.get(2..2 + count).ok_or_else(truncated)?;
            let length = digits
                .iter()
                .fold(0usize, |total, byte| (total << 8) | usize::from(*byte));
            (length, 2 + count)
        };
        let end = header
            .checked_add(length)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(truncated)?;
        let content = &self.bytes[header..end];
        self.bytes = &self.bytes[end..];
        Ok((tag, content))
    }

    fn expect(&mut self, tag: u8) -> Result<&'a [u8], String> {
        let (found, content) = self.next()?;
        if found != tag {
            return Err(format!(
                "SNMP message has tag 0x{found:02x} where 0x{tag:02x} was expected"
            ));
        }
        Ok(content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oid(text: &str) -> Vec<u32> {
        parse_oid(text).unwrap()
    }

    #[test]
    fn a_get_request_matches_the_reference_bytes() {
        // snmpget -v2c -c public host 1.3.6.1.2.1.1.5.0, request id 1.
        let packet = encode_request(b"public", 1, PduKind::Get, &[oid("1.3.6.1.2.1.1.5.0")])
            .unwrap();
        let expected: Vec<u8> = vec![
            0x30, 0x26, 0x02, 0x01, 0x01, 0x04, 0x06, b'p', b'u', b'b', b'l', b'i', b'c', 0xA0,
            0x19, 0x02, 0x01, 0x01, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00, 0x30, 0x0E, 0x30, 0x0C,
            0x06, 0x08, 0x2B, 0x06, 0x01, 0x02, 0x01, 0x01, 0x05, 0x00, 0x05, 0x00,
        ];
        assert_eq!(packet, expected);
    }

    #[test]
    fn a_bulk_request_carries_its_repetitions() {
        let packet = encode_request(
            b"c",
            300,
            PduKind::GetBulk {
                non_repeaters: 0,
                max_repetitions: 16,
            },
            &[oid("1.3.6.1.2.1.2.2.1.2")],
        )
        .unwrap();
        // version, community, then the GetBulk PDU.
        let pdu_start = 2 + 3 + 3;
        assert_eq!(packet[pdu_start], 0xA5);
        let pdu = &packet[pdu_start + 2..];
        assert_eq!(&pdu[..4], &[0x02, 0x02, 0x01, 0x2C]);
        assert_eq!(&pdu[4..10], &[0x02, 0x01, 0x00, 0x02, 0x01, 0x10]);
    }

    #[test]
    fn integers_use_the_shortest_twos_complement_form() {
        assert_eq!(encode_integer(0), vec![0x02, 0x01, 0x00]);
        assert_eq!(encode_integer(127), vec![0x02, 0x01, 0x7F]);
        assert_eq!(encode_integer(128), vec![0x02, 0x02, 0x00, 0x80]);
        assert_eq!(encode_integer(-1), vec![0x02, 0x01, 0xFF]);
        assert_eq!(encode_integer(-129), vec![0x02, 0x02, 0xFF, 0x7F]);
        for value in [0, 1, 127, 128, 255, 256, -1, -128, -129, i64::from(i32::MAX), i64::from(i32::MIN)] {
            let encoded = encode_integer(value);
            assert_eq!(decode_signed(&encoded[2..]).unwrap(), value);
        }
    }

    #[test]
    fn long_lengths_use_the_long_form() {
        let mut out = Vec::new();
        encode_length(200, &mut out);
        assert_eq!(out, vec![0x81, 200]);
        out.clear();
        encode_length(1000, &mut out);
        assert_eq!(out, vec![0x82, 0x03, 0xE8]);
    }

    #[test]
    fn oids_round_trip_with_large_arcs() {
        let arcs = oid("1.3.6.1.4.1.2636.3.1.13.1.8.9.1.0.0");
        let encoded = encode_oid(&arcs).unwrap();
        assert_eq!(decode_oid(&encoded[2..]).unwrap(), arcs);
        let big = vec![2, 999, 4294967295];
        let encoded = encode_oid(&big).unwrap();
        assert_eq!(decode_oid(&encoded[2..]).unwrap(), big);
        assert!(parse_oid("1.40.1").is_none());
        assert!(parse_oid("3.1").is_none());
        assert!(parse_oid("1.3.x").is_none());
    }

    fn response_bytes(varbinds: &[(Vec<u32>, (u8, Vec<u8>))], request_id: i64, error: i64) -> Vec<u8> {
        let mut list = Vec::new();
        for (oid, (tag, content)) in varbinds {
            let mut pair = encode_oid(oid).unwrap();
            pair.extend(tlv(*tag, content));
            list.extend(tlv(TAG_SEQUENCE, &pair));
        }
        let mut pdu = encode_integer(request_id);
        pdu.extend(encode_integer(error));
        pdu.extend(encode_integer(0));
        pdu.extend(tlv(TAG_SEQUENCE, &list));
        let mut message = encode_integer(1);
        message.extend(tlv(TAG_OCTET_STRING, b"public"));
        message.extend(tlv(TAG_RESPONSE, &pdu));
        tlv(TAG_SEQUENCE, &message)
    }

    #[test]
    fn a_response_decodes_every_value_type() {
        let bytes = response_bytes(
            &[
                (oid("1.3.6.1.2.1.1.5.0"), (TAG_OCTET_STRING, b"core-sw".to_vec())),
                (oid("1.3.6.1.2.1.1.3.0"), (TAG_TIMETICKS, vec![0x00, 0xFF, 0xFF, 0xFF, 0xFF])),
                (oid("1.3.6.1.2.1.2.2.1.10.1"), (TAG_COUNTER32, vec![0x80, 0x00, 0x00, 0x00])),
                (oid("1.3.6.1.2.1.31.1.1.1.6.1"), (TAG_COUNTER64, vec![0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])),
                (oid("1.3.6.1.2.1.2.2.1.8.1"), (TAG_INTEGER, vec![0x01])),
                (oid("1.3.6.1.2.1.4.20.1.1.1"), (TAG_IP_ADDRESS, vec![10, 0, 0, 1])),
                (oid("1.3.6.1.2.1.1.9.0"), (TAG_NO_SUCH_INSTANCE, vec![])),
                (oid("1.3.6.1.2.1.99"), (TAG_END_OF_MIB_VIEW, vec![])),
            ],
            77,
            0,
        );
        let response = decode_response(&bytes).unwrap();
        assert_eq!(response.version, 1);
        assert_eq!(response.community, b"public");
        assert_eq!(response.request_id, 77);
        assert_eq!(response.error_status, 0);
        let values: Vec<_> = response.varbinds.iter().map(|(_, value)| value.clone()).collect();
        assert_eq!(values[0].as_text().as_deref(), Some("core-sw"));
        assert_eq!(values[1], SnmpValue::TimeTicks(u32::MAX));
        assert_eq!(values[2], SnmpValue::Counter32(0x8000_0000));
        assert_eq!(values[3], SnmpValue::Counter64(u64::MAX));
        assert_eq!(values[4], SnmpValue::Integer(1));
        assert_eq!(values[5], SnmpValue::IpAddress([10, 0, 0, 1]));
        assert!(values[6].is_exception());
        assert_eq!(values[7], SnmpValue::EndOfMibView);
    }

    #[test]
    fn malformed_responses_are_errors() {
        let good = response_bytes(&[(oid("1.3.6.1.2.1.1.5.0"), (TAG_NULL, vec![]))], 1, 0);
        for cut in 0..good.len() {
            assert!(decode_response(&good[..cut]).is_err(), "cut at {cut}");
        }
        // A request is not a response.
        let request = encode_request(b"public", 1, PduKind::Get, &[oid("1.3.6.1.2.1.1.5.0")]).unwrap();
        assert!(decode_response(&request).is_err());
        // Indefinite length.
        assert!(decode_response(&[0x30, 0x80, 0x00, 0x00]).is_err());
        // A 32-bit value that does not fit.
        assert!(decode_value(TAG_COUNTER32, &[0x01, 0x00, 0x00, 0x00, 0x00]).is_err());
        // An OID arc that overflows.
        assert!(decode_oid(&[0x2B, 0x9F, 0xFF, 0xFF, 0xFF, 0x7F]).is_err());
    }

    #[test]
    fn an_error_status_is_reported() {
        let bytes = response_bytes(&[(oid("1.3.6.1.2.1.1.5.0"), (TAG_NULL, vec![]))], 5, 2);
        let response = decode_response(&bytes).unwrap();
        assert_eq!(error_name(response.error_status), "noSuchName");
    }
}
