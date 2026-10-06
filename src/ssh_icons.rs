use gpui_kit::{AssetSource, Img, ObjectFit, SharedString, StyledImage, img};
use std::borrow::Cow;

macro_rules! ssh_icons {
    ($($name:literal),* $(,)?) => {
        pub(crate) const ICONS: &[(&str, &[u8])] = &[
            $(($name, include_bytes!(concat!("../assets/ssh-icons/", $name, ".svg"))),)*
        ];
    };
}

ssh_icons!(
    "linux",
    "almalinux",
    "alpine-linux",
    "amazon-rds",
    "amazon-s3",
    "amazon-web-services",
    "apache",
    "caddy",
    "centos",
    "cloudflare",
    "coolify",
    "db-ui",
    "debian",
    "digitalocean",
    "diskover",
    "docker",
    "drivebase",
    "elasticsearch",
    "fedora",
    "grafana",
    "hetzner",
    "kubernetes",
    "linuxserver-io",
    "mariadb",
    "mongodb",
    "mysql",
    "nginx",
    "nginx-proxy-manager",
    "opensearch",
    "openvpn",
    "portainer",
    "postgresql",
    "prometheus",
    "proxmox",
    "pterodactyl",
    "rabbitmq",
    "redis",
    "rocky-linux",
    "shellhub",
    "traefik",
    "truenas-scale",
    "ubuntu",
    "unraid",
    "visual-db",
    "vmware-esx",
    "windows-terminal",
    "wireguard",
);

pub(crate) struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        if let Some(name) = path
            .strip_prefix("ssh-icons/")
            .and_then(|path| path.strip_suffix(".svg"))
        {
            return Ok(ICONS
                .iter()
                .find(|(icon, _)| *icon == name)
                .map(|(_, bytes)| Cow::Borrowed(*bytes)));
        }
        gpui_kit::assets::AllAssets.load(path)
    }

    fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
        let mut paths = gpui_kit::assets::AllAssets.list(path)?;
        paths.extend(
            ICONS
                .iter()
                .map(|(name, _)| format!("ssh-icons/{name}.svg"))
                .filter(|name| name.starts_with(path))
                .map(Into::into),
        );
        Ok(paths)
    }
}

pub(crate) fn image(name: &str) -> Img {
    let name = if ICONS.iter().any(|(icon, _)| *icon == name) {
        name
    } else {
        "linux"
    };
    img(format!("ssh-icons/{name}.svg")).object_fit(ObjectFit::Contain)
}
