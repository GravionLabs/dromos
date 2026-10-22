//! `dromos-mux`: terminal multiplexer (daemon and client).

use std::process::ExitCode;

const USAGE: &str = "usage: dromos-mux <daemon|client>";

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Daemon,
    Client,
}

#[derive(Debug, PartialEq, Eq)]
struct Usage;

fn parse<I, S>(args: I) -> Result<Command, Usage>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut args = args.into_iter();
    match (args.next().as_ref().map(AsRef::as_ref), args.next()) {
        (Some("daemon"), None) => Ok(Command::Daemon),
        (Some("client"), None) => Ok(Command::Client),
        _ => Err(Usage),
    }
}

fn main() -> ExitCode {
    match parse(std::env::args().skip(1)) {
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

    #[test]
    fn parses_daemon() {
        assert_eq!(parse(["daemon"]), Ok(Command::Daemon));
    }

    #[test]
    fn parses_client() {
        assert_eq!(parse(["client"]), Ok(Command::Client));
    }

    #[test]
    fn rejects_unknown_subcommand() {
        assert_eq!(parse(["bogus"]), Err(Usage));
    }

    #[test]
    fn rejects_missing_subcommand() {
        assert_eq!(parse(Vec::<String>::new()), Err(Usage));
    }

    #[test]
    fn rejects_extra_arguments() {
        assert_eq!(parse(["daemon", "extra"]), Err(Usage));
    }
}
