set -eu
archive=$1
kind=$2
case "$kind" in
    zip) tool=unzip ;;
    tar|file) tool=zstd ;;
    *) echo 'Unsupported archive type.' >&2; exit 1 ;;
esac
work=
trap 'if [ -n "$work" ]; then rm -rf -- "$work"; fi' 0
trap 'exit 1' HUP INT TERM

binary=$(command -v "$tool" || :)
if [ -z "$binary" ]; then
    bin="${3:-${HOME:?Could not locate your home directory}/.local/bin}"
    binary="$bin/$tool"
    if [ ! -x "$binary" ]; then
        manager=
        for candidate in apt-get dnf yum zypper apk pacman pkg brew; do
            if command -v "$candidate" >/dev/null; then manager=$candidate; break; fi
        done
        case "$manager" in
            brew) set -- brew install --force-bottle "$tool" ;;
            apt-get) set -- apt-get install -y "$tool" ;;
            dnf|yum) set -- "$manager" install -y "$tool" ;;
            zypper) set -- zypper --non-interactive install "$tool" ;;
            apk) set -- apk add "$tool" ;;
            pacman) set -- pacman -S --needed --noconfirm "$tool" ;;
            pkg) set -- pkg install -y "$tool" ;;
            *) printf 'No supported package manager found. Install %s and try again.\n' "$tool" >&2; exit 1 ;;
        esac
        printf 'Installing %s with %s…\n' "$tool" "$manager"
        if [ "$manager" = brew ] || [ "$(id -u)" = 0 ]; then
            "$@"
        else
            command -v sudo >/dev/null || { printf 'Installing %s requires sudo or an administrator.\n' "$tool" >&2; exit 1; }
            sudo "$@"
        fi
        binary=$(command -v "$tool" || :)
        [ -n "$binary" ] || { printf '%s was not found after installation. Check your PATH.\n' "$tool" >&2; exit 1; }
    fi
fi
if [ "$kind" = zip ]; then
    "$binary" "$archive"
elif [ "$kind" = tar ]; then
    work=$(mktemp -d "${TMPDIR:-/tmp}/rust-terminal-zstd.XXXXXX")
    "$binary" -dc -- "$archive" > "$work/archive.tar"
    tar -xf "$work/archive.tar"
else
    "$binary" -dk -- "$archive"
fi
