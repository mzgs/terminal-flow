param([string]$Archive, [bool]$IsTar)
$ErrorActionPreference = 'Stop'
$work = $null
try {
    $command = Get-Command zstd.exe -CommandType Application -ErrorAction SilentlyContinue
    $binary = if ($command) { $command.Source } else { Join-Path $env:LOCALAPPDATA 'RustTerminal\bin\zstd.exe' }
    if (!(Test-Path -LiteralPath $binary -PathType Leaf)) {
        $bin = Split-Path -Parent $binary
        New-Item -ItemType Directory -Force -Path $bin | Out-Null
        $work = Join-Path $bin ('.zstd-install-' + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $work | Out-Null
        $release = Invoke-RestMethod 'https://api.github.com/repos/facebook/zstd/releases/latest' -Headers @{ 'User-Agent' = 'RustTerminal' } -TimeoutSec 120
        $tag = $release.tag_name
        if ($tag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Invalid Zstandard release version.' }
        $bits = if ([Environment]::Is64BitOperatingSystem) { '64' } else { '32' }
        $name = "zstd-$tag-win$bits.zip"
        $asset = $release.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
        $url = "https://github.com/facebook/zstd/releases/download/$tag/$name"
        if (!$asset -or $asset.browser_download_url -ne $url) { throw 'This Zstandard release has no compatible Windows binary.' }
        Write-Host "Installing Zstandard $tag into $bin…"
        $zip = Join-Path $work 'download.zip'
        Invoke-WebRequest $url -OutFile $zip -UseBasicParsing -TimeoutSec 120
        if ($asset.digest) {
            if ($asset.digest -notmatch '^sha256:([0-9a-fA-F]{64})$') { throw 'Invalid Zstandard checksum.' }
            $expected = $Matches[1]
            if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $expected) { throw 'Zstandard checksum mismatch.' }
        }
        Expand-Archive -LiteralPath $zip -DestinationPath $work
        $candidate = Join-Path $work "zstd-$tag-win$bits\zstd.exe"
        & $candidate --version
        if ($LASTEXITCODE -ne 0) { throw 'The downloaded Zstandard binary could not run.' }
        Move-Item -LiteralPath $candidate -Destination $binary -Force
        Remove-Item -LiteralPath $work -Recurse -Force
        $work = $null
    }
    if ($IsTar) {
        $work = Join-Path ([IO.Path]::GetTempPath()) ('rust-terminal-zstd-' + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $work | Out-Null
        $tar = Join-Path $work 'archive.tar'
        & $binary -dk -o $tar -- $Archive
        if ($LASTEXITCODE -ne 0) { throw 'Zstandard decompression failed.' }
        & tar -xf $tar
    } else {
        & $binary -dk -- $Archive
    }
    if ($LASTEXITCODE -ne 0) { throw 'Archive extraction failed.' }
} finally {
    if ($work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
