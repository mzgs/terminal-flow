#!/bin/sh
set -eu

# CI releases stay ad-hoc signed. Local installs keep one identity in the Keychain.
identity=-
if [ "${GITHUB_ACTIONS:-false}" != true ]; then
    signing_dir="$HOME/Library/Application Support/TerminalFlow/signing"
    certificate="$signing_dir/certificate.der"
    if [ ! -f "$certificate" ]; then
        umask 077
        mkdir -p "$signing_dir"
        temporary=$(mktemp -d)
        trap 'rm -rf "$temporary"' EXIT HUP INT TERM
        cat > "$temporary/openssl.cnf" <<'CONFIG'
[req]
distinguished_name = name
x509_extensions = signing
prompt = no
[name]
CN = TerminalFlow Local Signing
[signing]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CONFIG
        /usr/bin/openssl req -new -x509 -newkey rsa:2048 -nodes -days 36500 \
            -config "$temporary/openssl.cnf" -keyout "$temporary/key.pem" \
            -out "$temporary/certificate.pem" 2> "$temporary/openssl.log"
        /usr/bin/openssl rand -hex 32 > "$temporary/password"
        /usr/bin/openssl pkcs12 -export -inkey "$temporary/key.pem" \
            -in "$temporary/certificate.pem" -out "$temporary/identity.p12" \
            -passout "file:$temporary/password"
        keychain=$(/usr/bin/security default-keychain -d user | tr -d '"' | sed 's/^ *//')
        /usr/bin/security import "$temporary/identity.p12" -k "$keychain" \
            -f pkcs12 -P "$(cat "$temporary/password")" -x -T /usr/bin/codesign
        /usr/bin/openssl x509 -in "$temporary/certificate.pem" -outform DER -out "$certificate"
    fi
    identity=$(/usr/bin/shasum -a 1 "$certificate" | cut -c 1-40)
fi

for bundle in "$@"; do
    /usr/bin/codesign --force --sign "$identity" --timestamp=none "$bundle"
    /usr/bin/codesign --verify --deep --strict "$bundle"
done
