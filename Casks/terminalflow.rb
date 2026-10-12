cask "terminalflow" do
  version "1.0.11"
  sha256 "c8390dcc07caf2d32c311ce8dbf7a26a6ef85803d8120277c49eb33f8cb95dfe"

  url "https://github.com/mzgs/terminal-flow/releases/download/v#{version}/TerminalFlow-mac-arm64.zip"
  name "TerminalFlow"
  desc "Native terminal workspace with SSH, SFTP, and a built-in editor"
  homepage "https://github.com/mzgs/terminal-flow"

  depends_on arch: :arm64
  depends_on :macos

  app "TerminalFlow.app"
end
