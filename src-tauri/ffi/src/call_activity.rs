//! Latency-critical activity while a call is live (macOS): a thin wrapper
//! around the statically linked Swift bridge. The app counts the calls and
//! calls these one at a time.
extern "C" {
    fn bitsov_call_activity_begin();
    fn bitsov_call_activity_end();
}

/// Begin the activity; a second begin keeps the one already held.
pub fn begin() {
    // SAFETY: no arguments or retained memory. Swift's ProcessInfo is
    // thread-safe, and the caller serializes these two entry points.
    unsafe { bitsov_call_activity_begin() }
}

/// End the activity; without one, nothing happens.
pub fn end() {
    // SAFETY: as for `begin`.
    unsafe { bitsov_call_activity_end() }
}

#[cfg(test)]
mod tests {
    /// The real system call, repeated: a second begin keeps one activity and
    /// a second end finds none.
    #[test]
    fn begin_and_end_are_safe_to_repeat() {
        super::begin();
        super::begin();
        super::end();
        super::end();
    }
}
