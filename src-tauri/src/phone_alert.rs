//! Phone alert text as the `phone_notify` command accepts it. The window
//! only ever sends the app's own generic lines; this refuses anything else
//! shaped like an injection: empty, too long, or with control characters.

/// Longest alert title or body accepted, in characters.
pub const MAX_CHARS: usize = 120;

pub fn text(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Alert text is empty.".into());
    }
    if trimmed.chars().count() > MAX_CHARS {
        return Err("Alert text is too long.".into());
    }
    if trimmed.chars().any(|c| c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')) {
        return Err("Alert text has control characters.".into());
    }
    Ok(trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_apps_own_lines_pass_unchanged() {
        for line in ["BitSov", "You have a new message", "Du har en ny besked", "You missed a call", "Du har et ubesvaret opkald"] {
            assert_eq!(text(line).as_deref(), Ok(line));
        }
        assert_eq!(text("  BitSov  ").as_deref(), Ok("BitSov"));
    }

    #[test]
    fn empty_long_or_control_text_is_refused() {
        for bad in ["", "   ", "a\u{0}b", "line\nbreak", "tab\there", "evil\u{202e}txt", "x\u{2066}y"] {
            assert!(text(bad).is_err(), "{bad:?}");
        }
        assert!(text(&"n".repeat(MAX_CHARS)).is_ok());
        assert!(text(&"n".repeat(MAX_CHARS + 1)).is_err());
    }
}
