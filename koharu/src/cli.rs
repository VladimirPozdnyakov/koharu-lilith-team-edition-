use clap::Parser;

#[derive(Parser)]
#[command(version = crate::version::APP_VERSION, about)]
pub(crate) struct Cli {
    #[arg(short, long, help = "Download dynamic libraries and exit")]
    pub(crate) download: bool,
    #[arg(long, help = "Force CPU even if GPU is available")]
    pub(crate) cpu: bool,
    #[arg(long, help = "Enable debug console output")]
    pub(crate) debug: bool,
}
