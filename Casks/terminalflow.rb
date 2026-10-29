cask "terminalflow" do
  version "1.0.12"
  sha256 "232b44cefa5af2bbef841573136c0aa1a2f2d912b4040bbe6d22700e770d7da4"

  url "https://github.com/mzgs/terminal-flow/releases/download/v#{version}/TerminalFlow-mac-arm64.zip"
  name "TerminalFlow"
  desc "Native terminal workspace with SSH, SFTP, and a built-in editor"
  homepage "https://github.com/mzgs/terminal-flow"

  depends_on arch: :arm64
  depends_on :macos

  app "TerminalFlow.app"
end
