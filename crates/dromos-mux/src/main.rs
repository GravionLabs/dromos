//! `dromos-mux`: terminal multiplexer (daemon and client).

use std::ffi::OsString;
use std::process::ExitCode;

const USAGE: &str = "usage: dromos-mux <daemon|client>";

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Daemon,
    Client,
}

#[derive(Debug, PartialEq, Eq)]
struct Usage;

fn parse<I>(args: I) -> Result<Command, Usage>
where
    I: IntoIterator<Item = OsString>,
{
    let mut args = args.into_iter();
    let sub = args.next().ok_or(Usage)?;
    if args.next().is_some() {
        return Err(Usage);
    }
    match sub.to_str() {
        Some("daemon") => Ok(Command::Daemon),
        Some("client") => Ok(Command::Client),
        _ => Err(Usage),
    }
}

fn main() -> ExitCode {
    match parse(std::env::args_os().skip(1)) {
        Ok(Command::Daemon) => {
            println!(
                "dromos-mux daemon: not implemented yet (protocol v{})",
                dromos_mux_proto::PROTOCOL_VERSION
            );
            ExitCode::SUCCESS
        }
        Ok(Command::Client) => {
            println!("dromos-mux client: not implemented yet");
            ExitCode::SUCCESS
        }
        Err(Usage) => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_daemon() {
        assert_eq!(parse(args(&["daemon"])), Ok(Command::Daemon));
    }

    #[test]
    fn parses_client() {
        assert_eq!(parse(args(&["client"])), Ok(Command::Client));
    }

    #[test]
    fn rejects_unknown_subcommand() {
        assert_eq!(parse(args(&["bogus"])), Err(Usage));
    }

    #[test]
    fn rejects_missing_subcommand() {
        assert_eq!(parse(args(&[])), Err(Usage));
    }

    #[test]
    fn rejects_extra_arguments() {
        assert_eq!(parse(args(&["daemon", "extra"])), Err(Usage));
        assert_eq!(parse(args(&["client", "daemon"])), Err(Usage));
    }

    #[test]
    fn rejects_help_flags_and_empty_string() {
        for flag in ["--help", "-h", ""] {
            assert_eq!(parse(args(&[flag])), Err(Usage));
        }
    }

    #[test]
    fn rejects_case_variants() {
        assert_eq!(parse(args(&["Daemon"])), Err(Usage));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_non_utf8_argument() {
        use std::os::unix::ffi::OsStringExt;
        assert_eq!(parse([OsString::from_vec(vec![0xff, 0xfe])]), Err(Usage));
    }
}
