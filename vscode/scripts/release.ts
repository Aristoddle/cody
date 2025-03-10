import { execFileSync } from 'child_process'

import semver from 'semver'

/**
 * This script is used by the CI to publish the extension to the VS Code Marketplace.
 *
 * See [CONTRIBUTING.md](../CONTRIBUTING.md) for instructions on how to generate a stable release or
 * insiders release.
 *
 * All release types are triggered by the CI and should not be run locally.
 */

// eslint-disable-next-line  @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
const packageJSONVersionString: string = require('../package.json').version

// Check version validity.
const packageJSONVersion = semver.valid(packageJSONVersionString)
if (!packageJSONVersion) {
    console.error(
        `Invalid version in package.json: ${JSON.stringify(
            packageJSONVersionString
        )}. Versions must be valid semantic version strings.`
    )
    process.exit(1)
}

enum ReleaseType {
    Stable = 'stable',
    Insiders = 'insiders',
}
const releaseType = process.env.CODY_RELEASE_TYPE
function validateReleaseType(releaseType: string | undefined): asserts releaseType is ReleaseType {
    if (!releaseType || !Object.values(ReleaseType).includes(releaseType as ReleaseType)) {
        console.error(
            `Invalid release type ${JSON.stringify(releaseType)}. Valid values are: ${JSON.stringify(
                Object.values(ReleaseType)
            )}. Specify a a release type in the CODY_RELEASE_TYPE env var.`
        )
        process.exit(1)
    }
}
validateReleaseType(releaseType)

const dryRun = Boolean(process.env.CODY_RELEASE_DRY_RUN)

// Tokens are stored in the GitHub repository's secrets.
const tokens = {
    vscode: dryRun ? 'dry-run' : process.env.VSCODE_MARKETPLACE_TOKEN,
    openvsx: dryRun ? 'dry-run' : process.env.VSCODE_OPENVSX_TOKEN,
}
if (!tokens.vscode || !tokens.openvsx) {
    console.error('Missing required tokens.')
    process.exit(1)
}

// The insiders build is the stable version suffixed with "-" and the Unix time.
//
// For example: 0.4.4 in package.json -> 0.4.4-1689391131.
const insidersVersion = semver.inc(packageJSONVersion, 'minor')?.replace(/\.\d+$/, `.${Math.ceil(Date.now() / 1000)}`)
if (!insidersVersion) {
    console.error('Could not increment version for insiders release.')
    process.exit(1)
}

const version = releaseType === ReleaseType.Insiders ? insidersVersion : packageJSONVersion

// Package (build and bundle) the extension.
console.error(`Packaging ${releaseType} release at version ${version}...`)
execFileSync(
    'vsce',
    [
        'package',
        ...(releaseType === ReleaseType.Insiders
            ? [insidersVersion, '--pre-release', '--no-update-package-json', '--no-git-tag-version']
            : []),
        '--no-dependencies',
        '--out',
        'dist/cody.vsix',
    ],
    {
        stdio: 'inherit',
    }
)

// Publish the extension.
console.error(`Publishing ${releaseType} release at version ${version}...`)
if (dryRun) {
    console.error('Dry run complete. Skipping publish step.')
} else {
    // Publish to the VS Code Marketplace.
    execFileSync(
        'vsce',
        [
            'publish',
            ...(releaseType === ReleaseType.Insiders ? ['--pre-release', '--no-git-tag-version'] : []),
            '--packagePath',
            'dist/cody.vsix',
        ],
        {
            env: { ...process.env, VSCE_PAT: tokens.vscode },
            stdio: 'inherit',
        }
    )

    // Publish to the OpenVSX Registry.
    execFileSync(
        'ovsx',
        [
            'publish',
            ...(releaseType === ReleaseType.Insiders ? ['--pre-release'] : []),
            '--packagePath',
            'dist/cody.vsix',
            '--pat',
            tokens.openvsx,
        ],
        {
            stdio: 'inherit',
        }
    )
}

console.error('Done!')
