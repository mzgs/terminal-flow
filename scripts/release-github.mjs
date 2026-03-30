#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import process from 'node:process'

const args = process.argv.slice(2)
const options = {
  allowDirty: false,
  architectures: ['arm64', 'x64'],
  draft: false,
  dryRun: false,
  notesFile: null,
  prerelease: false,
  skipBuild: false,
  skipRelease: false,
  skipTag: false,
  version: null
}

function normalizeArchitecture(value) {
  return value === 'amd64' ? 'x64' : value
}

function printHelp() {
  console.log(`Usage: npm run release:github -- [options]

Options:
  --version <value>   Release version. Defaults to package.json version.
  --arch <values>     Comma-separated arch list. Defaults to arm64,x64.
  --notes-file <path> Use custom release notes instead of generated notes.
  --draft             Create the GitHub release as a draft.
  --prerelease        Mark the GitHub release as a prerelease.
  --skip-build        Reuse existing dist/ artifacts.
  --skip-tag          Do not create or push the git tag.
  --skip-release      Do not create or update the GitHub release.
  --allow-dirty       Allow running with uncommitted changes.
  --dry-run           Print the actions without changing git or GitHub.
  --help              Show this message.
`)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function run(command, commandArgs, label = `${command} ${commandArgs.join(' ')}`, allowFailure = false) {
  console.log(`\n> ${label}`)
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT_DIR,
    stdio: 'inherit'
  })

  if (result.status !== 0 && !allowFailure) {
    process.exit(result.status ?? 1)
  }

  return result
}

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  if (result.status !== 0) {
    const errorText = (result.stderr || result.stdout || '').trim()
    fail(errorText || `Command failed: ${command} ${commandArgs.join(' ')}`)
  }

  return result.stdout.trim()
}

function getArgValue(index, flag) {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    fail(`Missing value for ${flag}`)
  }

  return value
}

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]

  switch (arg) {
    case '--allow-dirty':
      options.allowDirty = true
      break
    case '--arch':
      options.architectures = getArgValue(index, arg)
        .split(',')
        .map((value) => normalizeArchitecture(value.trim()))
        .filter(Boolean)
      index += 1
      break
    case '--draft':
      options.draft = true
      break
    case '--dry-run':
      options.dryRun = true
      break
    case '--help':
      printHelp()
      process.exit(0)
    case '--notes-file':
      options.notesFile = getArgValue(index, arg)
      index += 1
      break
    case '--prerelease':
      options.prerelease = true
      break
    case '--skip-build':
      options.skipBuild = true
      break
    case '--skip-release':
      options.skipRelease = true
      break
    case '--skip-tag':
      options.skipTag = true
      break
    case '--version':
      options.version = getArgValue(index, arg)
      index += 1
      break
    default:
      fail(`Unknown option: ${arg}`)
  }
}

const ROOT_DIR = resolve(new URL('..', import.meta.url).pathname)
const packageJson = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8'))
const version = options.version ?? packageJson.version
const tag = version.startsWith('v') ? version : `v${version}`
const releaseVersion = tag.startsWith('v') ? tag.slice(1) : tag
const productName = packageJson.productName
const packageName = packageJson.name
const supportedArchitectures = new Set(['arm64', 'x64'])
const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
const statusOutput = capture('git', ['status', '--porcelain'])
const remoteUrl = capture('git', ['config', '--get', 'remote.origin.url'])

if (options.architectures.length === 0) {
  fail('At least one architecture must be provided via --arch.')
}

for (const architecture of options.architectures) {
  if (!supportedArchitectures.has(architecture)) {
    fail(`Unsupported architecture: ${architecture}`)
  }
}

if (statusOutput && !options.allowDirty) {
  fail('Working tree is dirty. Commit your changes or pass --allow-dirty.')
}

if (branch === 'HEAD') {
  fail('Detached HEAD is not supported for releases.')
}

const remoteMatch =
  remoteUrl.match(/^https:\/\/(?:[^:@]+:([^@]+)@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/) ||
  remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/)

if (!remoteMatch) {
  fail('origin must point to a GitHub repository.')
}

const owner = remoteUrl.startsWith('git@')
  ? remoteMatch[1]
  : remoteMatch[2]
const repo = remoteUrl.startsWith('git@')
  ? remoteMatch[2]
  : remoteMatch[3]
const githubToken =
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  (!remoteUrl.startsWith('git@') ? remoteMatch[1] : null)

if (!options.skipRelease && !githubToken) {
  fail('Set GITHUB_TOKEN or GH_TOKEN, or use an HTTPS origin URL with embedded credentials.')
}

const assets = options.architectures.flatMap((architecture) => [
  resolve(ROOT_DIR, 'dist', `${packageName}-${releaseVersion}-${architecture}.dmg`),
  resolve(ROOT_DIR, 'dist', `${productName}-${releaseVersion}-${architecture}-mac.zip`),
  resolve(ROOT_DIR, 'dist', `${packageName}-${releaseVersion}-${architecture}-setup.exe`),
  resolve(ROOT_DIR, 'dist', `${packageName}-${releaseVersion}-${architecture}.AppImage`)
])

function ensureAsset(path) {
  if (!existsSync(path)) {
    fail(`Expected release asset was not found: ${path}`)
  }
}

async function githubRequest(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'User-Agent': 'terminal-flow-release-script',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {})
    }
  })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    const text = await response.text()
    fail(`GitHub API request failed (${response.status}): ${text}`)
  }

  return response
}

async function createOrUpdateRelease() {
  const existingResponse = await githubRequest(`/repos/${owner}/${repo}/releases/tags/${tag}`)
  const notes = options.notesFile ? readFileSync(resolve(ROOT_DIR, options.notesFile), 'utf8') : null

  if (existingResponse) {
    const existingRelease = await existingResponse.json()

    if (!notes && !options.draft && !options.prerelease) {
      return existingRelease
    }

    const patchResponse = await githubRequest(`/repos/${owner}/${repo}/releases/${existingRelease.id}`, {
      body: JSON.stringify({
        body: notes ?? existingRelease.body,
        draft: options.draft,
        name: tag,
        prerelease: options.prerelease
      }),
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'PATCH'
    })

    return patchResponse.json()
  }

  const createResponse = await githubRequest(`/repos/${owner}/${repo}/releases`, {
    body: JSON.stringify({
      body: notes,
      draft: options.draft,
      generate_release_notes: !notes,
      name: tag,
      prerelease: options.prerelease,
      tag_name: tag,
      target_commitish: branch
    }),
    headers: {
      'Content-Type': 'application/json'
    },
    method: 'POST'
  })

  return createResponse.json()
}

async function uploadAssets(release) {
  const existingAssets = new Set(release.assets.map((asset) => asset.name))
  const uploadUrl = release.upload_url.replace(/\{.*$/, '')

  for (const assetPath of assets) {
    const assetName = basename(assetPath)

    if (existingAssets.has(assetName)) {
      console.log(`Skipping existing asset ${assetName}`)
      continue
    }

    console.log(`Uploading ${assetName}`)
    const response = await fetch(`${uploadUrl}?name=${encodeURIComponent(assetName)}`, {
      body: readFileSync(assetPath),
      headers: {
        Authorization: `Bearer ${githubToken}`,
        'Content-Type': 'application/octet-stream',
        'User-Agent': 'terminal-flow-release-script',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      method: 'POST'
    })

    if (!response.ok) {
      const text = await response.text()
      fail(`Asset upload failed for ${assetName} (${response.status}): ${text}`)
    }
  }
}

function ensureLocalTag() {
  const result = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
    cwd: ROOT_DIR,
    stdio: 'ignore'
  })

  return result.status === 0
}

function ensureRemoteTag() {
  const result = spawnSync('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`], {
    cwd: ROOT_DIR,
    stdio: 'ignore'
  })

  return result.status === 0
}

console.log(
  `Preparing GitHub release ${tag} from ${branch} (${options.architectures.join(', ')})`
)

if (!options.skipBuild) {
  run('npm', ['run', 'build'], 'npm run build')

  for (const architecture of options.architectures) {
    run(
      'npx',
      ['electron-builder', '--mac', `--${architecture}`],
      `npx electron-builder --mac --${architecture}`
    )
    run(
      'npx',
      ['electron-builder', '--win', `--${architecture}`],
      `npx electron-builder --win --${architecture}`
    )

    const linuxResult = run(
      'npx',
      ['electron-builder', '--linux', 'AppImage', `--${architecture}`],
      `npx electron-builder --linux AppImage --${architecture}`,
      true
    )

    if (linuxResult.status !== 0) {
      console.warn(
        `Linux AppImage build for ${architecture} exited non-zero. The script will continue only if the artifact exists.`
      )
    }
  }
}

assets.forEach(ensureAsset)

if (options.dryRun) {
  console.log('\nDry run summary:')
  console.log(`- tag: ${tag}`)
  console.log(`- repo: ${owner}/${repo}`)
  console.log(`- architectures: ${options.architectures.join(', ')}`)
  console.log(`- assets: ${assets.map((asset) => basename(asset)).join(', ')}`)
  process.exit(0)
}

if (!options.skipTag) {
  if (!ensureLocalTag()) {
    run('git', ['tag', '-a', tag, '-m', `${productName} ${tag}`], `git tag -a ${tag}`)
  } else {
    console.log(`Local tag ${tag} already exists`)
  }

  if (!ensureRemoteTag()) {
    run('git', ['push', 'origin', `refs/tags/${tag}`], `git push origin refs/tags/${tag}`)
  } else {
    console.log(`Remote tag ${tag} already exists`)
  }
}

if (!options.skipRelease) {
  const release = await createOrUpdateRelease()
  await uploadAssets(release)
  console.log(`Release published: ${release.html_url}`)
}
