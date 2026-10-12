cask "terminalflow" do
  version "1.0.10"
  sha256 "00379d4cfe1528d1857bf54df860cd4d2143ae2fadbe159940db1baef81408f0"

  url "https://github.com/mzgs/terminal-flow/releases/download/v#{version}/TerminalFlow-mac-arm64.zip"
  name "TerminalFlow"
  desc "Native terminal workspace with SSH, SFTP, and a built-in editor"
  homepage "https://github.com/mzgs/terminal-flow"

  depends_on arch: :arm64
  depends_on :macos

  app "TerminalFlow.app"
end
