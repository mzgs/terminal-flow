//! Manual macOS updates from the application's GitHub releases.
use crate::{CheckForUpdates, editor};
use anyhow::{Context as _, Result, ensure};
use gpui_kit::{
    App, AppContext, PromptLevel,
    component::{WindowExt, notification::Notification},
};
use ring::digest::{Context, SHA1_FOR_LEGACY_USE_ONLY, SHA256, digest};
use serde::Deserialize;
use std::{
    cell::Cell,
    ffi::CString,
    fs,
    io::Read,
    os::unix::{ffi::OsStrExt, fs::DirBuilderExt},
    path::{Component, Path, PathBuf},
    process::Command,
    rc::Rc,
};

const VERSION: &str = match option_env!("TERMINALFLOW_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};
const ASSET: &str = "TerminalFlow-mac-arm64.zip";
const REPOSITORY: &str = "https://github.com/mzgs/terminal-flow";

pub(crate) fn init(cx: &mut App) {
    let busy = Rc::new(Cell::new(false));
    cx.on_action(move |_: &CheckForUpdates, cx| {
        if busy.get() {
            return;
        }
        let Some(handle) = cx.active_window() else {
            return;
        };
        busy.set(true);
        let busy = busy.clone();
        // Menu actions run while their window is borrowed; update it after dispatch.
        cx.defer(move |cx| {
            if cx.update_window(handle, |_, window, cx| {
                window.push_notification(
                    Notification::info("Checking for updates and installing any newer version…")
                        .id::<CheckForUpdates>()
                        .autohide(false),
                    cx,
                );
            }).is_err() {
                busy.set(false);
                return;
            }
            let work = cx.background_spawn(async { update() });
            cx.spawn(async move |cx| {
                let result = work.await;
                let restart = matches!(&result, Ok(Some(_)));
                let (level, message, detail) = match result {
                    Ok(Some(version)) => (
                        PromptLevel::Info,
                        format!("TerminalFlow {version} is installed"),
                        "Restart to use the update. Running terminals will close; your workspace will be saved.".to_owned(),
                    ),
                    Ok(None) => (
                        PromptLevel::Info,
                        "TerminalFlow is up to date".to_owned(),
                        String::new(),
                    ),
                    Err(error) => (
                        PromptLevel::Warning,
                        "Couldn’t update TerminalFlow".to_owned(),
                        format!("{error:#}"),
                    ),
                };
                let answers = if restart { vec!["Restart", "Later"] } else { vec!["OK"] };
                let prompt = cx.update_window(handle, |_, window, cx| {
                    window.remove_notification::<CheckForUpdates>(cx);
                    window.prompt(level, &message, Some(&detail), &answers, cx)
                });
                if let Ok(prompt) = prompt {
                    let answer = prompt.await;
                    if restart && answer == Ok(0) {
                        cx.update(|cx| {
                            if !editor::prevent_restart(cx) {
                                cx.restart();
                            }
                        });
                    }
                }
                busy.set(false);
            }).detach();
        });
    });
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    digest: Option<String>,
    size: u64,
}

fn version(value: &str) -> Result<[u64; 3]> {
    let parts: Vec<_> = value
        .trim()
        .strip_prefix('v')
        .unwrap_or(value.trim())
        .split('.')
        .collect();
    ensure!(
        parts.len() == 3
            && parts
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())),
        "Invalid release version: {value}"
    );
    Ok([parts[0].parse()?, parts[1].parse()?, parts[2].parse()?])
}

fn needs_update(installed: &str, running: &str, release: &str) -> Result<bool> {
    Ok(version(release)? > version(installed)?.max(version(running)?))
}

fn command(command: &mut Command) -> Result<Vec<u8>> {
    let program = command.get_program().to_string_lossy().into_owned();
    let output = command
        .output()
        .with_context(|| format!("Couldn’t run {program}"))?;
    ensure!(
        output.status.success(),
        "{program}: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(output.stdout)
}

fn curl(url: &str, limit: u64) -> Command {
    let mut curl = Command::new("/usr/bin/curl");
    curl.args([
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--connect-timeout",
        "10",
        "--max-time",
        "300",
        "--user-agent",
        "TerminalFlow",
        "--max-filesize",
    ])
    .arg(limit.to_string())
    .arg(url);
    curl
}

fn app_bundle(executable: &Path) -> Result<PathBuf> {
    let bundle = executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .context("Run the installed TerminalFlow.app to update")?;
    ensure!(
        bundle
            .extension()
            .is_some_and(|extension| extension == "app")
            && executable
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == "MacOS")
            && executable
                .parent()
                .and_then(Path::parent)
                .and_then(Path::file_name)
                .is_some_and(|name| name == "Contents"),
        "Run the installed TerminalFlow.app to update"
    );
    Ok(bundle.to_owned())
}

fn plist(bundle: &Path, key: &str) -> Result<String> {
    let bytes = command(
        Command::new("/usr/bin/plutil")
            .args(["-extract", key, "raw", "-o", "-"])
            .arg(bundle.join("Contents/Info.plist")),
    )?;
    Ok(String::from_utf8(bytes)?.trim().to_owned())
}

struct Staging(PathBuf);
impl Staging {
    fn new(parent: &Path) -> Result<Self> {
        let path = parent.join(format!(".terminalflow-update-{}", uuid::Uuid::new_v4()));
        fs::DirBuilder::new().mode(0o700).create(&path).context("The app folder is not writable. Move TerminalFlow to a writable Applications folder and try again")?;
        Ok(Self(path))
    }
}
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn verify_checksum(path: &Path, expected: &str) -> Result<()> {
    let expected = expected
        .strip_prefix("sha256:")
        .context("The release has no SHA-256 checksum")?;
    ensure!(
        expected.len() == 64 && expected.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid release checksum"
    );
    let mut file = fs::File::open(path)?;
    let mut hash = Context::new(&SHA256);
    let mut buffer = [0; 16 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    let actual: String = hash
        .finish()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    ensure!(
        actual.eq_ignore_ascii_case(expected),
        "The update checksum does not match. The installed app was preserved"
    );
    Ok(())
}

fn validate_archive_listing(listing: &str) -> Result<()> {
    ensure!(!listing.is_empty(), "The update archive is empty");
    for entry in listing.lines() {
        let path = Path::new(entry);
        ensure!(
            path.components()
                .all(|part| matches!(part, Component::Normal(_)))
                && (path.starts_with("TerminalFlow.app") || path.starts_with("__MACOSX")),
            "Unsafe path in the update archive"
        );
    }
    Ok(())
}

fn replace_bundle(staged: &Path, installed: &Path) -> Result<()> {
    unsafe extern "C" {
        fn renamex_np(
            from: *const std::ffi::c_char,
            to: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    let from = CString::new(staged.as_os_str().as_bytes())?;
    let to = CString::new(installed.as_os_str().as_bytes())?;
    // RENAME_SWAP atomically exchanges bundles on the same macOS volume.
    // SAFETY: both pointers are valid, NUL-terminated paths for the duration of the call.
    if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 0x00000002) } != 0 {
        return Err(std::io::Error::last_os_error())
            .context("Couldn’t replace the app. The installed app was preserved");
    }
    Ok(())
}

fn update() -> Result<Option<String>> {
    ensure!(
        cfg!(target_arch = "aarch64"),
        "Automatic updates currently require an Apple Silicon Mac"
    );
    let bundle = app_bundle(&std::env::current_exe()?)?;
    let installed = plist(&bundle, "CFBundleVersion")?;
    let release: Release = serde_json::from_slice(&command(&mut curl(
        "https://api.github.com/repos/mzgs/terminal-flow/releases/latest",
        1024 * 1024,
    ))?)?;
    ensure!(
        !release.draft && !release.prerelease,
        "The latest release is not a stable version"
    );
    let latest = version(&release.tag_name)?;
    if !needs_update(&installed, VERSION, &release.tag_name)? {
        return Ok((version(&installed)? > version(VERSION)?).then_some(installed));
    }
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == ASSET)
        .context("The latest release has no macOS update")?;
    ensure!(
        asset.size > 0 && asset.size <= 256 * 1024 * 1024,
        "Invalid update size"
    );
    let digest = asset
        .digest
        .as_deref()
        .context("The release has no download checksum")?;
    let staging = Staging::new(bundle.parent().context("The app has no parent folder")?)?;
    let archive = staging.0.join("update.zip");
    command(
        curl(
            &format!(
                "{REPOSITORY}/releases/download/{}/{ASSET}",
                release.tag_name
            ),
            asset.size,
        )
        .arg("--output")
        .arg(&archive),
    )?;
    ensure!(
        fs::metadata(&archive)?.len() == asset.size,
        "The update download is incomplete"
    );
    verify_checksum(&archive, digest)?;
    install_archive(&archive, &staging.0, &bundle, latest)?;
    Ok(Some(release.tag_name))
}

fn install_archive(
    archive: &Path,
    directory: &Path,
    bundle: &Path,
    latest: [u64; 3],
) -> Result<()> {
    let listing = command(Command::new("/usr/bin/unzip").arg("-Z1").arg(archive))?;
    validate_archive_listing(&String::from_utf8(listing)?)?;
    command(
        Command::new("/usr/bin/ditto")
            .args(["-x", "-k"])
            .arg(archive)
            .arg(directory),
    )?;
    let staged = directory.join("TerminalFlow.app");
    ensure!(
        plist(&staged, "CFBundleIdentifier")? == "com.local-terminal.app"
            && plist(&staged, "CFBundleExecutable")? == "local-terminal"
            && fs::symlink_metadata(staged.join("Contents/MacOS/local-terminal"))?.is_file(),
        "The update is not a TerminalFlow app"
    );
    ensure!(
        version(&plist(&staged, "CFBundleVersion")?)? == latest,
        "The release bundle has an incorrect version. Try again after a corrected release is published"
    );
    command(
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(&staged),
    )?;
    preserve_local_signature(&staged, bundle, directory)?;
    replace_bundle(&staged, bundle)
}

fn preserve_local_signature(staged: &Path, installed: &Path, directory: &Path) -> Result<()> {
    let certificate = dirs::home_dir()
        .context("Couldn’t find the home folder")?
        .join("Library/Application Support/TerminalFlow/signing/certificate.der");
    if !certificate.exists() {
        return Ok(());
    }
    let prefix = directory.join("installed-certificate");
    let output = Command::new("/usr/bin/codesign")
        .arg("--display")
        .arg(format!("--extract-certificates={}", prefix.display()))
        .arg(installed)
        .output()?;
    let leaf = directory.join("installed-certificate0");
    if !output.status.success() || !leaf.exists() {
        return Ok(()); // Ad-hoc releases have no certificate to preserve.
    }
    let certificate = fs::read(certificate)?;
    if fs::read(leaf)? != certificate {
        return Ok(());
    }
    // SHA-1 is codesign's Keychain identity selector, not the update checksum.
    let identity: String = digest(&SHA1_FOR_LEGACY_USE_ONLY, &certificate)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    command(
        Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", &identity, "--timestamp=none"])
            .arg(staged),
    )
    .context("Couldn’t preserve the local signing identity. The installed app was preserved")?;
    command(
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(staged),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_builds_and_pending_restarts_do_not_download_older_releases() -> Result<()> {
        assert!(!needs_update("0.1.0", "1.0.7", "v1.0.7")?);
        assert!(!needs_update("1.0.7", "1.0.7", "v1.0.6")?);
        assert!(!needs_update("1.0.8", "1.0.7", "v1.0.8")?);
        assert!(needs_update("1.0.7", "1.0.7", "v1.0.8")?);
        Ok(())
    }

    #[gpui_kit::test]
    fn update_menu_action_reports_an_unbundled_app(cx: &mut gpui_kit::TestAppContext) {
        use gpui_kit::{component::Root, px, size, test::TestWindowExt};
        cx.update(|cx| {
            gpui_kit::init(cx);
            init(cx);
        });
        let handle = cx.open_window(size(px(640.), px(480.)), |window, cx| {
            let workspace = cx.new(|cx| {
                crate::workspace::Workspace::restore(
                    None,
                    crate::storage::Settings::default(),
                    Default::default(),
                    None,
                    window,
                    cx,
                )
            });
            Root::new(workspace, window, cx)
        });
        cx.update_window(handle.into(), |_, window, cx| {
            window.activate_window();
            window.render_frame(cx);
            window.dispatch_action(Box::new(CheckForUpdates), cx);
        })
        .unwrap();
        cx.run_until_parked();
        let (message, detail) = cx
            .pending_prompt()
            .expect("The menu action must report the update result");
        assert_eq!(message, "Couldn’t update TerminalFlow");
        assert!(detail.contains("Run the installed TerminalFlow.app to update"));
        cx.simulate_prompt_answer("OK");
        cx.run_until_parked();
        assert!(!cx.has_pending_prompt());
    }

    #[test]
    fn versions_paths_and_checksums_reject_invalid_updates() -> Result<()> {
        assert!(version("v1.0.10")? > version("1.0.9")?);
        assert_eq!(version("v1.2.3")?, version("1.2.3")?);
        for invalid in ["", "1.2", "1.2.3.4", "1.2.3-beta", "../1.2.3", "1.2.-3"] {
            assert!(version(invalid).is_err());
        }
        assert!(app_bundle(Path::new("/tmp/local-terminal")).is_err());
        assert_eq!(
            app_bundle(Path::new(
                "/Applications/TerminalFlow.app/Contents/MacOS/local-terminal"
            ))?,
            Path::new("/Applications/TerminalFlow.app")
        );
        validate_archive_listing(
            "TerminalFlow.app/Contents/Info.plist\n__MACOSX/TerminalFlow.app/._Contents\n",
        )?;
        for invalid in [
            "",
            "/TerminalFlow.app/file",
            "TerminalFlow.app/../../file",
            "Other.app/file",
        ] {
            assert!(validate_archive_listing(invalid).is_err());
        }
        let staging = Staging::new(&std::env::temp_dir())?;
        let file = staging.0.join("download");
        fs::write(&file, b"abc")?;
        verify_checksum(
            &file,
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        )?;
        assert!(verify_checksum(&file, &format!("sha256:{}", "0".repeat(64))).is_err());
        assert!(verify_checksum(&file, "sha256:invalid").is_err());
        Ok(())
    }

    #[test]
    fn bundle_replacement_is_atomic_and_preserves_original_on_failure() -> Result<()> {
        let staging = Staging::new(&std::env::temp_dir())?;
        let installed = staging.0.join("TerminalFlow.app");
        let new = staging.0.join("new.app");
        fs::create_dir(&installed)?;
        fs::create_dir(&new)?;
        fs::write(installed.join("version"), b"old")?;
        fs::write(new.join("version"), b"new")?;
        replace_bundle(&new, &installed)?;
        assert_eq!(fs::read(installed.join("version"))?, b"new");
        assert_eq!(fs::read(new.join("version"))?, b"old");
        assert!(replace_bundle(&staging.0.join("missing"), &installed).is_err());
        assert_eq!(fs::read(installed.join("version"))?, b"new");
        Ok(())
    }

    #[test]
    fn installs_a_signed_archive_and_preserves_the_app_for_invalid_releases() -> Result<()> {
        let root = Staging::new(&std::env::temp_dir())?;
        let source = root.0.join("source/TerminalFlow.app");
        test_bundle(&source)?;
        command(
            Command::new("/usr/bin/codesign")
                .args(["--force", "--sign", "-"])
                .arg(&source),
        )?;
        let installed = root.0.join("installed.app");
        fs::create_dir(&installed)?;
        fs::write(installed.join("original"), b"preserved")?;
        let archive = root.0.join("update.zip");
        let zip = || {
            command(
                Command::new("/usr/bin/ditto")
                    .args(["-c", "-k", "--sequesterRsrc", "--keepParent"])
                    .arg(&source)
                    .arg(&archive),
            )
        };
        zip()?;
        let unpack = Staging::new(&root.0)?;
        assert!(install_archive(&archive, &unpack.0, &installed, [1, 0, 11]).is_err());
        assert_eq!(fs::read(installed.join("original"))?, b"preserved");
        // Changing a sealed resource must fail signature validation before replacement.
        fs::write(
            source.join("Contents/Info.plist"),
            fs::read(source.join("Contents/Info.plist"))?
                .into_iter()
                .chain(b"\n".iter().copied())
                .collect::<Vec<_>>(),
        )?;
        zip()?;
        let unpack = Staging::new(&root.0)?;
        assert!(install_archive(&archive, &unpack.0, &installed, [1, 0, 10]).is_err());
        assert_eq!(fs::read(installed.join("original"))?, b"preserved");
        command(
            Command::new("/usr/bin/codesign")
                .args(["--force", "--sign", "-"])
                .arg(&source),
        )?;
        zip()?;
        let unpack = Staging::new(&root.0)?;
        install_archive(&archive, &unpack.0, &installed, [1, 0, 10])?;
        assert_eq!(plist(&installed, "CFBundleVersion")?, "1.0.10");
        assert!(!installed.join("original").exists());
        assert_eq!(
            fs::read(unpack.0.join("TerminalFlow.app/original"))?,
            b"preserved"
        );
        Ok(())
    }

    #[test]
    #[ignore = "creates/reuses the local signing identity in the login Keychain"]
    fn local_updates_preserve_the_designated_requirement() -> Result<()> {
        let root = Staging::new(&std::env::temp_dir())?;
        let installed = root.0.join("installed.app");
        test_bundle(&installed)?;
        command(Command::new("scripts/sign-macos-app.sh").arg(&installed))?;
        let requirement = String::from_utf8(command(
            Command::new("/usr/bin/codesign")
                .args(["--display", "-r-"])
                .arg(&installed),
        )?)?;
        let requirement = requirement.trim().strip_prefix("designated => ").unwrap();
        assert!(requirement.contains("certificate leaf"));
        assert!(!requirement.contains("cdhash"));

        let source = root.0.join("source/TerminalFlow.app");
        test_bundle(&source)?;
        command(
            Command::new("/usr/bin/plutil")
                .args(["-replace", "CFBundleVersion", "-string", "1.0.11"])
                .arg(source.join("Contents/Info.plist")),
        )?;
        command(
            Command::new("/usr/bin/codesign")
                .args(["--force", "--sign", "-"])
                .arg(&source),
        )?;
        let archive = root.0.join("update.zip");
        command(
            Command::new("/usr/bin/ditto")
                .args(["-c", "-k", "--keepParent"])
                .arg(&source)
                .arg(&archive),
        )?;
        let unpack = Staging::new(&root.0)?;
        install_archive(&archive, &unpack.0, &installed, [1, 0, 11])?;
        assert_eq!(plist(&installed, "CFBundleVersion")?, "1.0.11");
        command(
            Command::new("/usr/bin/codesign")
                .args(["--verify", "--strict", "-R"])
                .arg(format!("={requirement}"))
                .arg(&installed),
        )?;
        // Reinstalling a changed bundle must also retain the same identity.
        command(Command::new("scripts/sign-macos-app.sh").arg(&source))?;
        command(
            Command::new("/usr/bin/codesign")
                .args(["--verify", "--strict", "-R"])
                .arg(format!("={requirement}"))
                .arg(&source),
        )?;
        Ok(())
    }

    fn test_bundle(path: &Path) -> Result<()> {
        fs::create_dir_all(path.join("Contents/MacOS"))?;
        fs::write(
            path.join("Contents/Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.local-terminal.app</string>
<key>CFBundleExecutable</key><string>local-terminal</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1.0.10</string>
</dict></plist>"#,
        )?;
        fs::copy("/bin/echo", path.join("Contents/MacOS/local-terminal"))?;
        Ok(())
    }
}
