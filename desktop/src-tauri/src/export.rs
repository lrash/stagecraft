//! The write-up export (DESIGN R-39): a native save dialog, and Rust writes the file.
//! The page never gets a filesystem permission; it hands over a name and the text.

/// Makes the page's suggested name safe to offer as a file name: no path separators, no drive
/// colon, no control characters, at most 120 characters, and never empty.
pub fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':') && !c.is_control())
        .take(120)
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').to_string();
    if trimmed.is_empty() {
        "stagecraft.md".into()
    } else {
        trimmed
    }
}

/// How a self-test answers the save dialog (`STAGECRAFT_SELFTEST_DIALOG`): a path saves there,
/// `cancel`/`no`/`yes` mean "the user cancelled" (only a path can answer a save dialog).
pub enum DialogAnswer {
    Cancel,
    Path(std::path::PathBuf),
}

pub fn selftest_answer(spec: &str) -> DialogAnswer {
    match spec {
        "" | "cancel" | "no" | "yes" => DialogAnswer::Cancel,
        p => DialogAnswer::Path(p.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_separators_and_controls() {
        assert_eq!(sanitize_name("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_name("a\\b:c\u{0}\n.md"), "abc.md");
    }

    #[test]
    fn caps_the_length() {
        let long = "x".repeat(300) + ".md";
        assert_eq!(sanitize_name(&long).chars().count(), 120);
    }

    #[test]
    fn never_empty_or_hidden() {
        assert_eq!(sanitize_name(""), "stagecraft.md");
        assert_eq!(sanitize_name("///"), "stagecraft.md");
        assert_eq!(sanitize_name(".hidden.md"), "hidden.md");
    }

    #[test]
    fn keeps_an_ordinary_name() {
        assert_eq!(sanitize_name("idea-2026-11-16-v3-2of6-qwen3-14b.md"), "idea-2026-11-16-v3-2of6-qwen3-14b.md");
    }

    #[test]
    fn selftest_answers() {
        assert!(matches!(selftest_answer("cancel"), DialogAnswer::Cancel));
        assert!(matches!(selftest_answer("/tmp/x.md"), DialogAnswer::Path(_)));
    }
}
