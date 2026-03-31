#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
  --version <value>   Release version. Defaults to package.json version and auto-bumps patch if needed.
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

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function hasMacSigningIdentity() {
  if (hasValue(process.env.CSC_LINK) || hasValue(process.env.CSC_NAME)) {
    return true
  }

  if (process.platform !== 'darwin') {
    return false
  }

  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  if (result.status !== 0) {
    return false
  }

  const output = `${result.stdout}\n${result.stderr}`
  return /(Developer ID Application:|Apple Distribution:|Mac Developer:|3rd Party Mac Developer Application:)/.test(
    output
  )
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

function normalizeTag(value) {
  return value.startsWith('v') ? value : `v${value}`
}

function parsePatchVersion(value) {
  const normalizedValue = value.startsWith('v') ? value.slice(1) : value
  const match = normalizedValue.match(/^(\d+)\.(\d+)\.(\d+)$/)

  if (!match) {
    return null
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  }
}

function incrementPatchVersion(value) {
  const parsedVersion = parsePatchVersion(value)

  if (!parsedVersion) {
    fail(`Automatic version bump requires a MAJOR.MINOR.PATCH version. Received: ${value}`)
  }

  return `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch + 1}`
}

function parseGitHubOrigin(value) {
  if (value.startsWith('https://')) {
    let url

    try {
      url = new URL(value)
    } catch {
      fail('origin must be a valid GitHub URL.')
    }

    if (url.hostname !== 'github.com') {
      fail('origin must point to a GitHub repository.')
    }

    const pathMatch = url.pathname.match(/^\/([^/]+)\/(.+?)(?:\.git)?\/?$/)

    if (!pathMatch) {
      fail('origin must point to a GitHub repository.')
    }

    return {
      isHttps: true,
      owner: pathMatch[1],
      password: decodeURIComponent(url.password),
      repo: pathMatch[2],
      username: decodeURIComponent(url.username)
    }
  }

  const sshMatch = value.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/)

  if (!sshMatch) {
    fail('origin must point to a GitHub repository.')
  }

  return {
    isHttps: false,
    owner: sshMatch[1],
    password: '',
    repo: sshMatch[2],
    username: ''
  }
}

function looksLikeGitHubToken(value) {
  return /^(gh[pousr]_|github_pat_)/.test(value)
}

function resolveGitHubAuthFromOriginUrl(origin) {
  if (!origin.isHttps) {
    return null
  }

  if (hasValue(origin.password)) {
    return {
      header: `Bearer ${origin.password}`,
      source: 'origin URL'
    }
  }

  if (looksLikeGitHubToken(origin.username)) {
    return {
      header: `Bearer ${origin.username}`,
      source: 'origin URL'
    }
  }

  return null
}

const ROOT_DIR = resolve(new URL('..', import.meta.url).pathname)
const packageJson = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8'))
const productName = packageJson.productName
const packageName = packageJson.name
const distDir = resolve(ROOT_DIR, 'dist')
const supportedArchitectures = new Set(['arm64', 'x64'])
const hasMacCodeSigningIdentity = hasMacSigningIdentity()
const macBuildOverrides = hasMacCodeSigningIdentity
  ? []
  : ['--config.mac.identity=-', '--config.mac.hardenedRuntime=false']
const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
const statusOutput = capture('git', ['status', '--porcelain'])
const remoteUrl = capture('git', ['config', '--get', 'remote.origin.url'])
const origin = parseGitHubOrigin(remoteUrl)

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

function collectExistingTags() {
  const tags = new Set()
  const localTagsOutput = capture('git', ['tag', '--list', 'v*'])
  const remoteTagsResult = spawnSync('git', ['ls-remote', '--tags', 'origin', 'refs/tags/v*'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  if (remoteTagsResult.status !== 0) {
    const errorText = (remoteTagsResult.stderr || remoteTagsResult.stdout || '').trim()
    fail(errorText || 'Failed to list remote tags from origin.')
  }

  for (const tagName of localTagsOutput.split('\n').map((value) => value.trim()).filter(Boolean)) {
    tags.add(tagName)
  }

  for (const line of remoteTagsResult.stdout.split('\n')) {
    const [, ref = ''] = line.trim().split(/\s+/)
    if (!ref) {
      continue
    }

    const normalizedRef = ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '')
    if (normalizedRef) {
      tags.add(normalizedRef)
    }
  }

  return tags
}

function resolveReleaseTag() {
  const requestedTag = normalizeTag(options.version ?? packageJson.version)

  if (options.version) {
    return {
      autoIncremented: false,
      requestedTag,
      tag: requestedTag
    }
  }

  const existingTags = collectExistingTags()
  let candidateTag = requestedTag
  let candidateVersion = candidateTag.slice(1)
  let autoIncremented = false

  while (existingTags.has(candidateTag)) {
    candidateVersion = incrementPatchVersion(candidateVersion)
    candidateTag = normalizeTag(candidateVersion)
    autoIncremented = true
  }

  return {
    autoIncremented,
    requestedTag,
    tag: candidateTag
  }
}

const owner = origin.owner
const repo = origin.repo
const githubAuth = resolveGitHubAuthFromOriginUrl(origin)

if (!options.skipRelease && !githubAuth) {
  fail('origin must include GitHub credentials in its HTTPS URL.')
}

const resolvedRelease = resolveReleaseTag()
const tag = resolvedRelease.tag
const releaseVersion = tag.startsWith('v') ? tag.slice(1) : tag
const builderVersionOverrides = [`--config.extraMetadata.version=${releaseVersion}`]
let assets = []

function resolveAsset(label, candidateNames) {
  const existingCandidate = candidateNames.find((candidateName) => existsSync(resolve(distDir, candidateName)))

  if (existingCandidate) {
    return resolve(distDir, existingCandidate)
  }

  const availableAssets = existsSync(distDir) ? readdirSync(distDir).sort() : []
  const checkedAssets = candidateNames.map((candidateName) => resolve(distDir, candidateName)).join(', ')
  const availableSummary = availableAssets.length > 0 ? ` Available dist assets: ${availableAssets.join(', ')}` : ''

  fail(`Expected ${label} release asset was not found. Checked: ${checkedAssets}.${availableSummary}`)
}

function getAppImageCandidates(architecture) {
  if (architecture === 'x64') {
    return [
      `${packageName}-${releaseVersion}-${architecture}.AppImage`,
      `${packageName}-${releaseVersion}-x86_64.AppImage`
    ]
  }

  return [`${packageName}-${releaseVersion}-${architecture}.AppImage`]
}

function collectReleaseAssets() {
  return options.architectures.flatMap((architecture) => [
    resolveAsset('macOS DMG', [`${packageName}-${releaseVersion}-${architecture}.dmg`]),
    resolveAsset('Windows installer', [`${packageName}-${releaseVersion}-${architecture}-setup.exe`]),
    resolveAsset('Linux AppImage', getAppImageCandidates(architecture))
  ])
}

async function githubRequest(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: githubAuth.header,
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
    fail(`GitHub API request failed (${response.status}, ${githubAuth.source}): ${text}`)
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
        Authorization: githubAuth.header,
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

if (resolvedRelease.autoIncremented) {
  console.log(
    `Base version ${resolvedRelease.requestedTag} already exists. Using next available version ${tag}.`
  )
}

if (!hasMacCodeSigningIdentity) {
  console.warn(
    'No macOS signing identity detected. macOS release artifacts will be ad-hoc signed with hardened runtime disabled.'
  )
}

if (options.skipBuild && resolvedRelease.autoIncremented) {
  console.warn(
    `--skip-build is enabled, so dist/ must already contain artifacts for ${releaseVersion}.`
  )
}

if (!options.skipBuild) {
  run('npm', ['run', 'build'], 'npm run build')

  for (const architecture of options.architectures) {
    const macCommandArgs = [
      'electron-builder',
      '--mac',
      'dmg',
      `--${architecture}`,
      ...builderVersionOverrides,
      ...macBuildOverrides
    ]

    run(
      'npx',
      macCommandArgs,
      `npx ${macCommandArgs.join(' ')}`
    )
    run(
      'npx',
      ['electron-builder', '--win', 'nsis', `--${architecture}`, ...builderVersionOverrides],
      `npx electron-builder --win nsis --${architecture} ${builderVersionOverrides.join(' ')}`
    )

    const linuxResult = run(
      'npx',
      ['electron-builder', '--linux', 'AppImage', `--${architecture}`, ...builderVersionOverrides],
      `npx electron-builder --linux AppImage --${architecture} ${builderVersionOverrides.join(' ')}`,
      true
    )

    if (linuxResult.status !== 0) {
      console.warn(
        `Linux AppImage build for ${architecture} exited non-zero. The script will continue only if the artifact exists.`
      )
    }
  }
}

assets = collectReleaseAssets()

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
