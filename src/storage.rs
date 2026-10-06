use anyhow::{Context as _, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use ring::{
    aead, digest,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct LegacySecret {
    nonce: [u8; 12],
    ciphertext: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub(crate) struct Settings {
    pub restore_session: bool,
    pub default_directory: Option<PathBuf>,
    pub font_family: String,
    pub font_size: f32,
    #[serde(flatten)]
    pub appearance: crate::appearance::Appearance,
    pub ssh_servers: Vec<SshProfile>,
    pub quick_commands: Vec<QuickCommand>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            restore_session: true,
            default_directory: None,
            font_family: "JetBrains Mono".into(),
            font_size: 14.,
            appearance: Default::default(),
            ssh_servers: vec![],
            quick_commands: vec![],
        }
    }
}

impl Settings {
    pub(crate) fn read_backup(path: &Path) -> Result<Self> {
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 16 * 1024 * 1024,
            "Settings backup is too large."
        );
        let value: serde_json::Value = serde_json::from_slice(&bytes)?;
        ensure!(
            value.get("font_family").is_some() && value.get("font_size").is_some(),
            "Choose a TerminalFlow settings backup."
        );
        let settings: Self = serde_json::from_value(value)?;
        settings.validate()?;
        Ok(settings)
    }

    pub(crate) fn write_backup(&self, path: &Path) -> Result<()> {
        self.validate()?;
        write_json(path, self)
    }

    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(
            self.font_size.is_finite() && (10.0..=32.0).contains(&self.font_size),
            "Font size must be between 10 and 32."
        );
        ensure!(!self.font_family.trim().is_empty(), "Enter a font family.");
        self.appearance.validate()?;
        let mut ids = std::collections::HashSet::new();
        for profile in &self.ssh_servers {
            profile.validate()?;
            ensure!(ids.insert(&profile.id), "Duplicate SSH profile ID.");
        }
        for command in &self.quick_commands {
            command.validate()?;
            ensure!(ids.insert(&command.id), "Duplicate quick command ID.");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(crate) struct QuickCommand {
    pub id: String,
    pub name: String,
    pub command: String,
}

impl QuickCommand {
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(
            Uuid::parse_str(&self.id).is_ok(),
            "Invalid quick command ID."
        );
        ensure!(!self.name.trim().is_empty(), "Enter a quick command name.");
        ensure!(
            !self.command.trim().is_empty() && !self.command.contains('\0'),
            "Enter a quick command without NUL characters."
        );
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Authentication {
    Password,
    #[default]
    PrivateKey,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub(crate) struct SshProfile {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub authentication: Authentication,
    pub private_key: Option<PathBuf>,
    pub remote_directory: String,
    #[serde(rename = "password", alias = "secret")]
    pub secret: Option<String>,
}

impl Default for SshProfile {
    fn default() -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: String::new(),
            icon: "linux".into(),
            host: String::new(),
            port: 22,
            username: "root".into(),
            authentication: Authentication::PrivateKey,
            private_key: None,
            remote_directory: String::new(),
            secret: None,
        }
    }
}

impl SshProfile {
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(Uuid::parse_str(&self.id).is_ok(), "Invalid SSH profile ID.");
        ensure!(!self.name.trim().is_empty(), "Enter a connection name.");
        // Hosts and usernames become SSH arguments, never shell source or options.
        ensure!(
            !self.host.is_empty()
                && !self.host.starts_with('-')
                && self
                    .host
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".:-_%".contains(c)),
            "Enter a hostname or IP address without spaces."
        );
        ensure!(
            !self.username.is_empty()
                && !self.username.starts_with('-')
                && self
                    .username
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)),
            "Enter a valid SSH username."
        );
        ensure!(self.port > 0, "Port must be between 1 and 65535.");
        ensure!(
            !self.remote_directory.contains(['\0', '\n', '\r']),
            "Remote directory must be a single path."
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum TabSource {
    Local {
        directory: Option<PathBuf>,
    },
    Ssh {
        profile_id: String,
        directory: String,
    },
}

impl Default for TabSource {
    fn default() -> Self {
        Self::Local { directory: None }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(crate) struct TabSnapshot {
    pub id: String,
    pub source: TabSource,
    #[serde(default)]
    pub output: Vec<String>,
    #[serde(default = "default_scale")]
    pub font_scale: f32,
    #[serde(default)]
    pub scroll_offset: f32,
    #[serde(default)]
    pub browser: BrowserSnapshot,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub(crate) struct BrowserSnapshot {
    /// Width in rem, so the panel follows interface scale.
    pub width: f32,
}
impl Default for BrowserSnapshot {
    fn default() -> Self {
        Self { width: 20. }
    }
}
fn default_scale() -> f32 {
    1.
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub(crate) struct Snapshot {
    pub version: u32,
    pub active_tab: Option<String>,
    pub tabs: Vec<TabSnapshot>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            version: 1,
            active_tab: None,
            tabs: vec![],
        }
    }
}

impl Snapshot {
    pub(crate) fn validate(&mut self) -> Result<()> {
        ensure!(self.version == 1, "Unsupported terminal session version.");
        let mut ids = std::collections::HashSet::new();
        for tab in &mut self.tabs {
            tab.browser.width = if tab.browser.width.is_finite() {
                tab.browser.width.clamp(15., 40.)
            } else {
                20.
            };
            ensure!(
                Uuid::parse_str(&tab.id).is_ok() && ids.insert(&tab.id),
                "Invalid or duplicate terminal tab ID."
            );
            if let TabSource::Ssh {
                profile_id,
                directory,
            } = &tab.source
            {
                ensure!(
                    Uuid::parse_str(profile_id).is_ok(),
                    "Invalid saved SSH profile ID."
                );
                ensure!(
                    !directory.contains(['\0', '\n', '\r']),
                    "Invalid saved remote directory."
                );
            }
            tab.font_scale = if tab.font_scale.is_finite() {
                tab.font_scale.clamp(0.5, 2.5)
            } else {
                1.
            };
            tab.scroll_offset = if tab.scroll_offset.is_finite() {
                tab.scroll_offset.max(0.)
            } else {
                0.
            };
            if matches!(tab.source, TabSource::Ssh { .. }) {
                tab.output.clear();
            }
            if tab.output.len() > 500 {
                tab.output.drain(..tab.output.len() - 500);
            }
        }
        if !self
            .active_tab
            .as_ref()
            .is_some_and(|id| self.tabs.iter().any(|tab| &tab.id == id))
        {
            self.active_tab = self.tabs.first().map(|tab| tab.id.clone());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct WindowState {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub maximized: bool,
}

#[derive(Clone)]
pub(crate) struct Store {
    directory: PathBuf,
    session_sequence: std::sync::Arc<std::sync::atomic::AtomicU64>,
    session_write: std::sync::Arc<std::sync::Mutex<u64>>,
}

impl Store {
    pub(crate) fn new() -> Result<Self> {
        let directory = dirs::data_local_dir()
            .context("Couldn’t find the application data directory")?
            .join("RustTerminal");
        Ok(Self::at(directory))
    }

    pub(crate) fn at(directory: PathBuf) -> Self {
        Self {
            directory,
            session_sequence: Default::default(),
            session_write: Default::default(),
        }
    }

    pub(crate) fn next_session_revision(&self) -> u64 {
        self.session_sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1
    }

    pub(crate) fn save_session(
        &self,
        revision: u64,
        snapshot: &Snapshot,
        window: &WindowState,
    ) -> Result<()> {
        let mut last = self
            .session_write
            .lock()
            .map_err(|_| anyhow::anyhow!("Session writer failed"))?;
        if revision > *last {
            self.save("terminal-session.json", snapshot)?;
            self.save("window-state.json", window)?;
            *last = revision;
        }
        Ok(())
    }

    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }

    pub(crate) fn load_settings(&self) -> Result<Settings> {
        if !self.directory.join("settings.json").exists() {
            return Ok(Settings::default());
        }
        let mut value: serde_json::Value = self.load("settings.json")?;
        let mut migrated = false;
        if let Some(profiles) = value.get_mut("ssh_servers").and_then(|v| v.as_array_mut()) {
            for profile in profiles {
                if profile.get("secret").is_some_and(|v| v.is_object()) {
                    let secret: LegacySecret = serde_json::from_value(profile["secret"].clone())?;
                    let id = profile["id"].as_str().context("Missing SSH profile ID")?;
                    let key = fs::read(self.directory.join("credentials.key"))
                        .context("Restore credentials.key to migrate saved SSH passwords.")?;
                    let password = decrypt_bytes(&key, id, secret.nonce, secret.ciphertext)?;
                    profile["secret"] = self.encrypt(id, &password)?.into();
                    migrated = true;
                }
            }
        }
        let settings: Settings = serde_json::from_value(value)?;
        settings.validate()?;
        if migrated {
            self.save("settings.json", &settings)?;
        }
        // Only retire the old key after all profiles have migrated and saved successfully.
        match fs::remove_file(self.directory.join("credentials.key")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("Couldn’t remove the old credentials.key"),
        }
        Ok(settings)
    }

    pub(crate) fn load<T: DeserializeOwned + Default>(&self, name: &str) -> Result<T> {
        let path = self.directory.join(name);
        match fs::read(&path) {
            Ok(bytes) => {
                ensure!(
                    bytes.len() <= 16 * 1024 * 1024,
                    "{} is too large",
                    path.display()
                );
                serde_json::from_slice(&bytes)
                    .with_context(|| format!("Couldn’t read {}", path.display()))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
            Err(error) => Err(error).with_context(|| format!("Couldn’t read {}", path.display())),
        }
    }

    pub(crate) fn save(&self, name: &str, value: &impl Serialize) -> Result<()> {
        self.prepare_directory()?;
        write_json(&self.directory.join(name), value)
    }

    pub(crate) fn prepare_directory(&self) -> Result<()> {
        fs::create_dir_all(&self.directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.directory, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    pub(crate) fn encrypt(&self, id: &str, password: &str) -> Result<String> {
        let mut nonce = [0; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| anyhow::anyhow!("Couldn’t generate the password nonce"))?;
        let mut ciphertext = password.as_bytes().to_vec();
        let key = aead::UnboundKey::new(&aead::AES_256_GCM, app_encryption_key().as_ref())
            .map_err(|_| anyhow::anyhow!("Invalid app encryption key"))?;
        aead::LessSafeKey::new(key)
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(id.as_bytes()),
                &mut ciphertext,
            )
            .map_err(|_| anyhow::anyhow!("Couldn’t encrypt the password"))?;
        let tag = ciphertext.split_off(ciphertext.len() - aead::AES_256_GCM.tag_len());
        Ok(format!(
            "enc-v1:{}:{}:{}",
            BASE64.encode(nonce),
            BASE64.encode(tag),
            BASE64.encode(ciphertext)
        ))
    }

    pub(crate) fn decrypt(&self, id: &str, secret: &str) -> Result<String> {
        let parts: Vec<_> = secret.split(':').collect();
        ensure!(
            parts.len() == 4 && parts[0] == "enc-v1",
            "Invalid saved password format"
        );
        let nonce: [u8; 12] = BASE64
            .decode(parts[1])?
            .try_into()
            .map_err(|_| anyhow::anyhow!("Invalid saved password format"))?;
        let tag = BASE64.decode(parts[2])?;
        ensure!(
            tag.len() == aead::AES_256_GCM.tag_len(),
            "Invalid saved password format"
        );
        let mut bytes = BASE64.decode(parts[3])?;
        bytes.extend(tag);
        decrypt_bytes(app_encryption_key().as_ref(), id, nonce, bytes)
    }
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    let temporary = path.with_file_name(format!(".settings-{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.with_context(|| format!("Couldn’t save {}", path.display()))
}

fn app_encryption_key() -> digest::Digest {
    // Like terminal-flow, the app owns the key. This is obfuscation against casual
    // reading, not protection against someone who can inspect the app binary.
    digest::digest(&digest::SHA256, b"RustTerminal SSH passwords v1 2026-10-05")
}

fn decrypt_bytes(key: &[u8], id: &str, nonce: [u8; 12], mut bytes: Vec<u8>) -> Result<String> {
    let key = aead::UnboundKey::new(&aead::AES_256_GCM, key)
        .map_err(|_| anyhow::anyhow!("Invalid credential encryption key"))?;
    let plaintext = aead::LessSafeKey::new(key)
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(id.as_bytes()),
            &mut bytes,
        )
        .map_err(|_| {
            anyhow::anyhow!("Couldn’t decrypt the saved password. Re-enter it in the SSH profile.")
        })?;
    String::from_utf8(plaintext.to_vec()).context("Invalid saved password")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_backups_round_trip_and_reject_invalid_input() -> Result<()> {
        let directory = std::env::temp_dir().join(format!("settings-backup-{}", Uuid::new_v4()));
        fs::create_dir(&directory)?;
        let path = directory.join("backup.json");
        let store = Store::at(directory.clone());
        let mut profile = SshProfile {
            name: "Backup".into(),
            host: "localhost".into(),
            ..SshProfile::default()
        };
        profile.secret = Some(store.encrypt(&profile.id, "password")?);
        let settings = Settings {
            font_size: 18.,
            restore_session: false,
            ssh_servers: vec![profile],
            quick_commands: vec![QuickCommand {
                id: Uuid::new_v4().to_string(),
                name: "List files".into(),
                command: "pwd\nls -la".into(),
            }],
            ..Settings::default()
        };
        settings.write_backup(&path)?;
        let imported = Settings::read_backup(&path)?;
        assert_eq!(imported, settings);
        let mut invalid = settings.clone();
        invalid.quick_commands[0].name = " ".into();
        assert!(invalid.validate().is_err());
        invalid = settings.clone();
        invalid.quick_commands[0].command = "echo\0bad".into();
        assert!(invalid.validate().is_err());
        invalid = settings.clone();
        invalid
            .quick_commands
            .push(invalid.quick_commands[0].clone());
        assert!(invalid.validate().is_err());
        assert!(
            serde_json::from_str::<Settings>(r#"{"font_family":"Hack","font_size":14}"#)?
                .quick_commands
                .is_empty()
        );
        assert_eq!(
            store.decrypt(
                &imported.ssh_servers[0].id,
                imported.ssh_servers[0].secret.as_ref().unwrap()
            )?,
            "password"
        );
        Settings::default().write_backup(&path)?;
        let original = fs::read(&path)?;
        assert!(
            Settings {
                font_size: 99.,
                ..settings.clone()
            }
            .write_backup(&path)
            .is_err()
        );
        assert_eq!(fs::read(&path)?, original);
        for invalid in [
            b"invalid".as_slice(),
            b"{}",
            b"[]",
            br#"{"font_family":"Hack","font_size":99}"#,
        ] {
            fs::write(&path, invalid)?;
            assert!(Settings::read_backup(&path).is_err());
        }
        fs::File::create(&path)?.set_len(16 * 1024 * 1024 + 1)?;
        assert!(Settings::read_backup(&path).is_err());
        fs::remove_dir_all(directory)?;
        Ok(())
    }

    #[test]
    fn app_encrypts_password_strings_without_a_key_file() -> Result<()> {
        let store =
            Store::at(std::env::temp_dir().join(format!("rust-terminal-test-{}", Uuid::new_v4())));
        let mut profile = SshProfile {
            name: "Test".into(),
            host: "localhost".into(),
            ..SshProfile::default()
        };
        let password = "a password with '$` and Unicode 密碼";
        let secret = store.encrypt(&profile.id, password)?;
        assert!(!store.directory.exists());
        assert_ne!(secret, store.encrypt(&profile.id, password)?);
        assert_eq!(store.decrypt(&profile.id, &secret)?, password);
        assert!(store.decrypt("another-profile", &secret).is_err());
        for part in 1..4 {
            let mut damaged: Vec<_> = secret.split(':').map(str::to_string).collect();
            let mut bytes = BASE64.decode(&damaged[part])?;
            bytes[0] ^= 1;
            damaged[part] = BASE64.encode(bytes);
            assert!(store.decrypt(&profile.id, &damaged.join(":")).is_err());
        }
        for malformed in [
            "plaintext",
            "enc-v2:a:b:c",
            "enc-v1:a:b:c",
            "enc-v1:::",
            "enc-v1:a:b:c:extra",
        ] {
            assert!(store.decrypt(&profile.id, malformed).is_err());
        }
        assert_eq!(
            store.decrypt(&profile.id, &store.encrypt(&profile.id, "")?)?,
            ""
        );
        profile.secret = Some(secret);
        let settings = Settings {
            ssh_servers: vec![profile.clone()],
            ..Settings::default()
        };
        store.save("settings.json", &settings)?;
        let json = fs::read_to_string(store.directory.join("settings.json"))?;
        assert!(json.contains("\"password\": \"enc-v1:"));
        for absent in ["\"secret\"", "\"nonce\"", "\"ciphertext\"", password] {
            assert!(!json.contains(absent));
        }
        assert!(!store.directory.join("credentials.key").exists());
        let reopened = Store::at(store.directory.clone());
        assert_eq!(reopened.load_settings()?, settings);
        assert_eq!(
            reopened.decrypt(&profile.id, profile.secret.as_ref().unwrap())?,
            password
        );
        fs::remove_dir_all(store.directory)?;
        Ok(())
    }

    #[test]
    fn migrates_legacy_passwords_only_after_all_profiles_can_be_decrypted() -> Result<()> {
        let store =
            Store::at(std::env::temp_dir().join(format!("rust-terminal-test-{}", Uuid::new_v4())));
        let key = [7; 32];
        let profile = SshProfile {
            name: "Legacy".into(),
            host: "localhost".into(),
            ..SshProfile::default()
        };
        let mut bytes = b"saved password".to_vec();
        aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &key).unwrap())
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key([8; 12]),
                aead::Aad::from(profile.id.as_bytes()),
                &mut bytes,
            )
            .unwrap();
        let mut old_profile = serde_json::to_value(&profile)?;
        old_profile.as_object_mut().unwrap().remove("password");
        old_profile["secret"] = serde_json::to_value(LegacySecret {
            nonce: [8; 12],
            ciphertext: bytes,
        })?;
        let mut value = serde_json::to_value(Settings::default())?;
        value["ssh_servers"] = serde_json::json!([old_profile.clone()]);
        store.save("settings.json", &value)?;
        let original = fs::read(store.directory.join("settings.json"))?;
        assert!(store.load_settings().is_err());
        assert_eq!(fs::read(store.directory.join("settings.json"))?, original);

        fs::write(store.directory.join("credentials.key"), key)?;
        let mut damaged = old_profile.clone();
        damaged["id"] = Uuid::new_v4().to_string().into();
        value["ssh_servers"] = serde_json::json!([old_profile, damaged]);
        store.save("settings.json", &value)?;
        let damaged_settings = fs::read(store.directory.join("settings.json"))?;
        assert!(store.load_settings().is_err());
        assert_eq!(
            fs::read(store.directory.join("settings.json"))?,
            damaged_settings
        );
        assert_eq!(fs::read(store.directory.join("credentials.key"))?, key);

        value["ssh_servers"].as_array_mut().unwrap().pop();
        store.save("settings.json", &value)?;
        let settings = store.load_settings()?;
        assert_eq!(
            store.decrypt(
                &profile.id,
                settings.ssh_servers[0].secret.as_ref().unwrap()
            )?,
            "saved password"
        );
        assert!(!store.directory.join("credentials.key").exists());
        assert_eq!(store.load_settings()?, settings);
        let json = fs::read_to_string(store.directory.join("settings.json"))?;
        assert!(json.contains("\"password\": \"enc-v1:"));
        assert!(!json.contains("\"nonce\""));
        assert!(!json.contains("\"ciphertext\""));
        fs::remove_dir_all(store.directory)?;
        Ok(())
    }

    #[test]
    fn stores_settings_and_restores_bounded_local_output_and_ssh_metadata() -> Result<()> {
        let store =
            Store::at(std::env::temp_dir().join(format!("rust-terminal-test-{}", Uuid::new_v4())));
        let profile = SshProfile {
            name: "Production".into(),
            host: "::1".into(),
            ..SshProfile::default()
        };
        let mut legacy = serde_json::to_value(&profile)?;
        legacy.as_object_mut().unwrap().remove("icon");
        assert_eq!(serde_json::from_value::<SshProfile>(legacy)?.icon, "linux");
        let settings = Settings {
            ssh_servers: vec![profile.clone()],
            ..Settings::default()
        };
        settings.validate()?;
        store.save("settings.json", &settings)?;
        assert_eq!(store.load::<Settings>("settings.json")?, settings);
        let id = Uuid::new_v4().to_string();
        let mut snapshot = Snapshot {
            active_tab: Some(id.clone()),
            tabs: vec![
                TabSnapshot {
                    id,
                    source: TabSource::Local {
                        directory: Some("/tmp".into()),
                    },
                    output: (0..600).map(|n| n.to_string()).collect(),
                    font_scale: 1.2,
                    scroll_offset: 4.,
                    browser: Default::default(),
                },
                TabSnapshot {
                    id: Uuid::new_v4().to_string(),
                    source: TabSource::Ssh {
                        profile_id: profile.id,
                        directory: "/srv".into(),
                    },
                    output: vec!["remote secret".into()],
                    font_scale: 1.,
                    scroll_offset: 0.,
                    browser: BrowserSnapshot { width: 26. },
                },
            ],
            ..Snapshot::default()
        };
        snapshot.validate()?;
        assert_eq!(snapshot.tabs[0].output.len(), 500);
        assert_eq!(snapshot.tabs[0].output[0], "100");
        assert!(snapshot.tabs[1].output.is_empty());
        let mut legacy = serde_json::to_value(&snapshot)?;
        assert!(legacy["tabs"][1]["browser"].get("directory").is_none());
        legacy["tabs"][1]["browser"]["directory"] = "/old/browser/folder".into();
        assert_eq!(
            serde_json::from_value::<Snapshot>(legacy.clone())?,
            snapshot
        );
        legacy["tabs"][1].as_object_mut().unwrap().remove("browser");
        assert_eq!(
            serde_json::from_value::<Snapshot>(legacy)?.tabs[1].browser,
            BrowserSnapshot::default()
        );
        store.save("terminal-session.json", &snapshot)?;
        assert_eq!(store.load::<Snapshot>("terminal-session.json")?, snapshot);
        let older = store.next_session_revision();
        let newer = store.next_session_revision();
        store.save_session(newer, &snapshot, &WindowState::default())?;
        store.save_session(older, &Snapshot::default(), &WindowState::default())?;
        assert_eq!(store.load::<Snapshot>("terminal-session.json")?, snapshot);
        fs::write(store.directory.join("settings.json"), b"invalid")?;
        assert!(store.load::<Settings>("settings.json").is_err());
        assert_eq!(fs::read(store.directory.join("settings.json"))?, b"invalid");
        assert!(
            SshProfile {
                host: "-oProxyCommand=bad".into(),
                ..settings.ssh_servers[0].clone()
            }
            .validate()
            .is_err()
        );
        fs::remove_dir_all(store.directory)?;
        Ok(())
    }
}
