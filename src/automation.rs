use anyhow::{Result, bail, ensure};
use gpui_kit::http_client::Url;
use std::path::PathBuf;

#[derive(Debug, PartialEq)]
pub(super) enum Request {
    Activate,
    NewTerminal {
        directory: Option<PathBuf>,
        title: Option<String>,
        command: Option<String>,
    },
}

impl Request {
    pub(super) fn parse(input: &str) -> Result<Self> {
        ensure!(
            !input.chars().any(char::is_control),
            "Invalid URL characters."
        );
        let bytes = input.as_bytes();
        ensure!(
            bytes.iter().enumerate().all(|(ix, byte)| *byte != b'%'
                || bytes
                    .get(ix + 1..ix + 3)
                    .is_some_and(|digits| digits.iter().all(u8::is_ascii_hexdigit))),
            "Invalid percent encoding."
        );
        let url = Url::parse(input)?;
        ensure!(
            url.scheme() == "terminalflow"
                && url.username().is_empty()
                && url.password().is_none()
                && url.port().is_none()
                && matches!(url.path(), "" | "/")
                && url.fragment().is_none(),
            "Invalid TerminalFlow URL."
        );
        match url.host_str() {
            Some("activate") => {
                ensure!(
                    url.query().is_none(),
                    "Activate does not accept parameters."
                );
                Ok(Self::Activate)
            }
            Some("new-terminal") => {
                let (mut directory, mut title, mut command) = (None, None, None);
                for (key, value) in url.query_pairs() {
                    ensure!(!value.contains('\0'), "URL parameters cannot contain NUL.");
                    let slot = match key.as_ref() {
                        "cwd" => &mut directory,
                        "title" => &mut title,
                        "command" => &mut command,
                        _ => bail!("Unknown URL parameter: {key}."),
                    };
                    ensure!(slot.is_none(), "Duplicate URL parameter: {key}.");
                    *slot = Some(value.into_owned());
                }
                let directory = directory
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from);
                if let Some(directory) = &directory {
                    ensure!(
                        directory.is_absolute() && directory.is_dir(),
                        "cwd must be an existing absolute directory."
                    );
                }
                if let Some(title) = &title {
                    ensure!(
                        !title.chars().any(char::is_control),
                        "Invalid title characters."
                    );
                }
                if let Some(command) = &command {
                    ensure!(
                        !command
                            .chars()
                            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')),
                        "Invalid command characters."
                    );
                }
                Ok(Self::NewTerminal {
                    directory,
                    title: title.filter(|value| !value.is_empty()),
                    command: command.filter(|value| !value.trim().is_empty()),
                })
            }
            _ => bail!("Unknown TerminalFlow URL action."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automation_links_decode_parameters_and_reject_invalid_requests() {
        assert_eq!(
            Request::parse("terminalflow://activate").unwrap(),
            Request::Activate
        );
        assert_eq!(
            Request::parse("terminalflow://new-terminal").unwrap(),
            Request::NewTerminal {
                directory: None,
                title: None,
                command: None,
            }
        );
        assert_eq!(Request::parse("terminalflow://new-terminal/?cwd=%2F&title=Build+%E2%9C%93%26%23&command=printf%20%27a%2Bb%27%0Apwd").unwrap(), Request::NewTerminal {
            directory: Some(PathBuf::from("/")),
            title: Some("Build ✓&#".into()),
            command: Some("printf 'a+b'\npwd".into()),
        });
        for input in [
            "https://new-terminal",
            "terminalflow://unknown",
            "terminalflow://user@new-terminal",
            "terminalflow://new-terminal:22",
            "terminalflow://new-terminal/other",
            "terminalflow://new-terminal#command=pwd",
            "terminalflow://activate?command=pwd",
            "terminalflow://new-terminal?cwd=relative",
            "terminalflow://new-terminal?cwd=/nonexistent/terminalflow-directory",
            "terminalflow://new-terminal?title=x&title=y",
            "terminalflow://new-terminal?other=x",
            "terminalflow://new-terminal?command=%00",
            "terminalflow://new-terminal?command=%1B%5B200~pwd",
            "terminalflow://new-terminal?title=%0A",
            "terminalflow://new-terminal?title=%GG",
            "terminalflow://new-terminal?title=%",
            "terminalflow://new-terminal?title=%2",
        ] {
            assert!(Request::parse(input).is_err(), "{input}");
        }
    }
}
