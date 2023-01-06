/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { promisify } from 'node:util';
import { exec as execSync } from 'child_process';
import { arrayWithDeprecation, Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import { ensureString } from '@salesforce/ts-types';
import { Env } from '@salesforce/kit';
import { Octokit } from '@octokit/core';
import { Messages, SfError } from '@salesforce/core';
import { PackageRepo } from '../../../repository';

const exec = promisify(execSync);

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/plugin-release-management', 'cli.release.build');

export default class build extends SfCommand<void> {
  public static readonly description = messages.getMessage('description');
  public static readonly summary = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly aliases = ['cli:latestrc:build'];
  public static readonly flags = {
    'start-from-npm-dist-tag': Flags.string({
      summary: messages.getMessage('flags.startFromNpmDistTag'),
      char: 'd',
      aliases: ['rctag'],
      deprecateAliases: true,
      exactlyOne: ['start-from-npm-dist-tag', 'start-from-github-ref'],
    }),
    'start-from-github-ref': Flags.string({
      summary: messages.getMessage('flags.startFromGithubRef'),
      char: 'g',
      exactlyOne: ['start-from-npm-dist-tag', 'start-from-github-ref'],
    }),
    'build-only': Flags.boolean({
      summary: messages.getMessage('flags.buildOnly'),
      default: false,
    }),
    resolutions: Flags.boolean({
      summary: messages.getMessage('flags.resolutions'),
      default: true,
      allowNo: true,
    }),
    only: arrayWithDeprecation({
      summary: messages.getMessage('flags.only'),
    }),
    'pinned-deps': Flags.boolean({
      summary: messages.getMessage('flags.pinnedDeps'),
      default: true,
      allowNo: true,
    }),
    patch: Flags.boolean({
      summary: messages.getMessage('flags.patch'),
      exclusive: ['prerelease'],
    }),
    prerelease: Flags.string({
      summary: messages.getMessage('flags.prerelease'),
      exclusive: ['patch'],
    }),
    snapshot: Flags.boolean({
      summary: messages.getMessage('flags.snapshot'),
    }),
    schema: Flags.boolean({
      summary: messages.getMessage('flags.schema'),
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(build);

    const pushChangesToGitHub = !flags['build-only'];

    const auth = pushChangesToGitHub
      ? ensureString(
          new Env().getString('GH_TOKEN') ?? new Env().getString('GITHUB_TOKEN'),
          'The GH_TOKEN env var is required to push changes to GitHub. Use the --build-only flag to skip GitHub operations (a manual push will then be needed)'
        )
      : undefined;

    const ref = await this.getGithubRef(flags['start-from-github-ref'], flags['start-from-npm-dist-tag']);

    // Check out "starting point"
    // Works with sha (detached): "git checkout f476e8e"
    // Works with remote branch:  "git checkout my-branch"
    // Works with tag (detached): "git checkout 7.174.0"
    await this.exec(`git checkout ${ref}`);

    const repo = await PackageRepo.create({ ux: new Ux({ jsonEnabled: this.jsonEnabled() }) });

    // Get the current version for the "starting point"
    const currentVersion = repo.package.packageJson.version;

    // TODO: We might want to check and see if nextVersion exists
    // Determine the next version based on if --patch was passed in or if it is a prerelease
    const nextVersion = repo.package.determineNextVersion(flags.patch, flags.prerelease);
    repo.nextVersion = nextVersion;

    // Prereleases and patches need special branch prefixes to trigger GitHub Actions
    const branchPrefix = flags.patch ? 'patch/' : flags.prerelease ? 'prerelease/' : '';

    const branchName = `${branchPrefix}${nextVersion}`;

    this.log(`Starting from '${ref}' (${currentVersion}) and creating branch '${branchName}'`);

    // Create a new branch that matches the next version
    await this.exec(`git switch -c ${branchName}`);

    if (flags.patch && pushChangesToGitHub) {
      // Since patches can be created from any previous dist-tag or github ref,
      // it is unlikely that we would be able to merge these into main.
      // Before we make any changes, push this branch to use as our PR `base`.
      // The build-patch.yml GHA will watch for merges into this branch to trigger a patch release
      // TODO: ^ update this GHA reference once it is decided

      await this.exec(`git push -u origin ${branchName}`);
    }

    // bump the version in the pjson to the next version for this tag
    this.log(`Setting the version to ${nextVersion}`);
    repo.package.setNextVersion(nextVersion);
    repo.package.packageJson.version = nextVersion;

    if (flags.only) {
      this.log(`Bumping the following dependencies only: ${flags.only.join(', ')}`);
      const bumped = repo.package.bumpDependencyVersions(flags.only);

      if (!bumped.length) {
        throw new SfError(
          'No version changes made. Confirm you are passing the correct dependency and version to --only.'
        );
      }
    } else {
      // bump resolution deps
      if (flags.resolutions) {
        this.log('Bumping resolutions in the package.json to their "latest"');
        repo.package.bumpResolutions('latest');
      }

      // pin the pinned dependencies
      if (flags['pinned-deps']) {
        this.log('Pinning dependencies in pinnedDependencies to "latest-rc"');
        repo.package.pinDependencyVersions('latest-rc');
      }
    }
    repo.package.writePackageJson();

    await this.exec('yarn install');
    // streamline the lockfile
    await this.exec('npx yarn-deduplicate');

    if (flags.snapshot) {
      this.log('Updating snapshots');
      await this.exec(`./bin/${repo.name === 'sfdx-cli' ? 'dev.sh' : 'dev'} snapshot:generate`);
    }

    if (flags.schema) {
      this.log('Updating schema');
      await this.exec('sf-release cli:schemas:collect');
    }

    this.log('Updates complete');

    if (pushChangesToGitHub) {
      const octokit = new Octokit({ auth });

      await this.maybeSetGitConfig(octokit);

      // commit package.json/yarn.lock and potentially command-snapshot changes
      await this.exec('git add .');
      await this.exec(`git commit -m "chore(release): bump to ${nextVersion}"`);
      await this.exec(`git push --set-upstream origin ${branchName} --no-verify`);

      const [repoOwner, repoName] = repo.package.packageJson.repository.split('/');

      // TODO: Review this after prerelease flow is solidified
      const prereleaseDetails =
        '\n**IMPORTANT:**\nPrereleases work differently than regular releases. Github Actions watches for branches prefixed with `prerelease/`. As long as the `package.json` contains a valid "prerelease tag" (1.2.3-dev.0), a new prerelease will be created for EVERY COMMIT pushed to that branch. If you would like to merge this PR into `main`, simply push one more commit to this branch that sets the version in the `package.json` to the version you\'d like to release.';

      // If it is a patch, we will set the PR base to the prefixed branch we pushed earlier
      // The Github Action will watch the `patch/` prefix for changes
      const base = flags.patch ? `${branchName}` : 'main';

      await octokit.request(`POST /repos/${repoOwner}/${repoName}/pulls`, {
        owner: repoOwner,
        repo: repoName,
        head: nextVersion,
        base,
        title: `Release PR for ${nextVersion}`,
        body: `Building ${nextVersion} [skip-validate-pr]${flags.prerelease ? prereleaseDetails : ''}`,
      });
    }
  }

  private async getGithubRef(githubRef: string, distTag: string): Promise<string> {
    let ref: string;
    if (githubRef) {
      this.log(`Flag '--start-from-github-ref' passed, switching to '${githubRef}'`);

      ref = githubRef;
    } else {
      this.log(`Flag '--start-from-npm-dist-tag' passed, looking up version for ${distTag}`);

      const temp = await PackageRepo.create({ ux: new Ux({ jsonEnabled: this.jsonEnabled() }) });
      const version = temp.package.getDistTags(temp.package.packageJson.name)[distTag];
      ref = version;
    }

    return ref;
  }

  private async exec(command: string, silent = false): Promise<string> {
    try {
      const { stdout } = await exec(command);
      if (!silent) {
        this.styledHeader(command);
        this.log(stdout);
      }
      return stdout;
    } catch (err) {
      throw new SfError((err as Error).message);
    }
  }

  private async maybeSetGitConfig(octokit: Octokit): Promise<void> {
    const username = await this.exec('git config user.name', true);
    const email = await this.exec('git config user.email', true);
    if (!username || !email) {
      const user = await octokit.request('GET /user');
      if (!username) await this.exec(`git config user.name "${user.data.name}"`);
      if (!email) await this.exec(`git config user.email "${user.data.email}"`);
    }
  }
}