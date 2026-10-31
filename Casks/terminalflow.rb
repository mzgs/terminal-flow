cask "terminalflow" do
  version "1.0.13"
  sha256 "62abbb75dfe8779d5c0e42a88442832118d5b928b1ff2d531084c9faff8f93c1"

  url "https://github.com/mzgs/terminal-flow/releases/download/v#{version}/TerminalFlow-mac-arm64.zip"
  name "TerminalFlow"
  desc "Native terminal workspace with SSH, SFTP, and a built-in editor"
  homepage "https://github.com/mzgs/terminal-flow"

  depends_on arch: :arm64
  depends_on :macos

  app "TerminalFlow.app"
end
