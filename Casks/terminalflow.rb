cask "terminalflow" do
  version "1.0.9"
  sha256 "8c0841f9c4419a259e2c100432ed398ca0bd2bf05c2b7e6d7a9bdf1be8893964"

  url "https://github.com/mzgs/terminal-flow/releases/download/v#{version}/TerminalFlow-mac-arm64.zip"
  name "TerminalFlow"
  desc "Native terminal workspace with SSH, SFTP, and a built-in editor"
  homepage "https://github.com/mzgs/terminal-flow"

  depends_on arch: :arm64
  depends_on :macos

  app "TerminalFlow.app"
end
