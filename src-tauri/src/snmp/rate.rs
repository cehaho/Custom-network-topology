//! Bits per second from two readings of an interface octet counter.
//!
//! A 32-bit counter that goes down has wrapped once. A 64-bit counter that goes
//! down was reset. A lower sysUpTime means the agent restarted, so no rate is
//! given for that interval. A rate far above the link speed is a counter
//! discontinuity and is dropped too.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CounterWidth {
    Bits32,
    Bits64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    pub octets: u64,
    pub at_ms: u64,
    /// sysUpTime in hundredths of a second, when the agent gave it.
    pub uptime_ticks: Option<u32>,
}

/// A rate above this multiple of the link speed is treated as a discontinuity.
const SPEED_SLACK: f64 = 1.5;

pub fn counter_delta(previous: u64, current: u64, width: CounterWidth) -> Option<u64> {
    if current >= previous {
        return Some(current - previous);
    }
    match width {
        CounterWidth::Bits32 if previous <= u64::from(u32::MAX) && current <= u64::from(u32::MAX) => {
            Some((1u64 << 32) - previous + current)
        }
        _ => None,
    }
}

pub fn restarted(previous: &Sample, current: &Sample) -> bool {
    matches!(
        (previous.uptime_ticks, current.uptime_ticks),
        (Some(before), Some(now)) if now < before
    )
}

pub fn bits_per_second(
    previous: &Sample,
    current: &Sample,
    width: CounterWidth,
    speed_bps: Option<u64>,
) -> Option<f64> {
    if current.at_ms <= previous.at_ms || restarted(previous, current) {
        return None;
    }
    let delta = counter_delta(previous.octets, current.octets, width)?;
    let seconds = (current.at_ms - previous.at_ms) as f64 / 1000.0;
    let rate = delta as f64 * 8.0 / seconds;
    if let Some(speed) = speed_bps.filter(|speed| *speed > 0) {
        if rate > speed as f64 * SPEED_SLACK {
            return None;
        }
    }
    Some(rate)
}

/// Link speed in bits per second: ifHighSpeed (Mb/s) first, then ifSpeed.
pub fn link_speed_bps(high_speed_mbps: Option<u64>, speed_bps: Option<u64>) -> Option<u64> {
    match high_speed_mbps {
        Some(mbps) if mbps > 0 => mbps.checked_mul(1_000_000),
        _ => speed_bps.filter(|speed| *speed > 0 && *speed < u64::from(u32::MAX)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(octets: u64, at_ms: u64, uptime_ticks: Option<u32>) -> Sample {
        Sample {
            octets,
            at_ms,
            uptime_ticks,
        }
    }

    #[test]
    fn a_steady_counter_gives_bits_per_second() {
        let rate = bits_per_second(
            &sample(1_000, 0, Some(100)),
            &sample(126_000, 10_000, Some(1_100)),
            CounterWidth::Bits64,
            None,
        );
        assert_eq!(rate, Some(100_000.0));
    }

    #[test]
    fn a_32_bit_counter_that_goes_down_wrapped_once() {
        let previous = u64::from(u32::MAX) - 99;
        assert_eq!(counter_delta(previous, 50, CounterWidth::Bits32), Some(150));
        let rate = bits_per_second(
            &sample(previous, 0, Some(10)),
            &sample(50, 1_000, Some(110)),
            CounterWidth::Bits32,
            Some(1_000_000_000),
        );
        assert_eq!(rate, Some(1_200.0));
    }

    #[test]
    fn a_64_bit_counter_that_goes_down_was_reset() {
        assert_eq!(counter_delta(500, 10, CounterWidth::Bits64), None);
        assert_eq!(
            bits_per_second(
                &sample(500, 0, None),
                &sample(10, 1_000, None),
                CounterWidth::Bits64,
                None
            ),
            None
        );
    }

    #[test]
    fn a_restarted_agent_gives_no_rate() {
        let rate = bits_per_second(
            &sample(1_000, 0, Some(50_000)),
            &sample(2_000, 30_000, Some(200)),
            CounterWidth::Bits32,
            None,
        );
        assert_eq!(rate, None);
    }

    #[test]
    fn a_rate_far_above_link_speed_is_dropped() {
        // 100 Mb/s link, a jump that would mean 8 Gb/s.
        let rate = bits_per_second(
            &sample(0, 0, Some(1)),
            &sample(1_000_000_000, 1_000, Some(101)),
            CounterWidth::Bits64,
            Some(100_000_000),
        );
        assert_eq!(rate, None);
    }

    #[test]
    fn time_must_move_forward() {
        assert_eq!(
            bits_per_second(&sample(0, 5, None), &sample(10, 5, None), CounterWidth::Bits64, None),
            None
        );
    }

    #[test]
    fn link_speed_prefers_high_speed() {
        assert_eq!(link_speed_bps(Some(10_000), Some(u64::from(u32::MAX))), Some(10_000_000_000));
        assert_eq!(link_speed_bps(Some(0), Some(100_000_000)), Some(100_000_000));
        assert_eq!(link_speed_bps(None, Some(u64::from(u32::MAX))), None);
        assert_eq!(link_speed_bps(None, None), None);
    }
}
