/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import * as fg from 'fast-glob';
import { pwd, rm } from 'shelljs';
import { Flags, SfCommand } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { red } from 'chalk';
import { Interfaces } from '@oclif/core';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/plugin-release-management', 'cli.tarballs.prepare');

/**
 * The functionality of this command is taken entirely from https://github.com/salesforcecli/sfdx-cli/blob/v7.109.0/scripts/clean-for-tarballs
 */
export default class Prepare extends SfCommand<void> {
  public static readonly summary = messages.getMessage('description');
  public static readonly description = messages.getMessage('description');

  public static readonly examples = messages.getMessages('examples');
  public static readonly flags = {
    dryrun: Flags.boolean({
      summary: messages.getMessage('dryrun'),
      default: false,
      char: 'd',
    }),
    types: Flags.boolean({
      summary: messages.getMessage('types'),
      default: false,
      char: 't',
    }),
    verbose: Flags.boolean({
      summary: messages.getMessage('verbose'),
    }),
  };

  private flags!: Interfaces.InferredFlags<typeof Prepare.flags>;

  public async run(): Promise<void> {
    const { flags } = await this.parse(Prepare);
    this.flags = flags;

    const workingDir = pwd().stdout;
    const baseDirGlob = `${workingDir}/node_modules`;

    // Remove JSforceTestSuite from dist
    const jsForceTestSuite = await find(`${baseDirGlob}/JSforceTestSuite`, { onlyDirectories: true });
    this.remove(jsForceTestSuite, 'JSforceTestSuite files');

    // Module readmes and other markdown docs not found in template directories
    const markdownFiles = await find(`${baseDirGlob}/**/*.md`, {
      excludeDirectories: ['templates', 'messages'],
    });
    this.remove(markdownFiles, '.md files');

    // Module .gitignore not found in template directories
    const gitignore = await find(`${baseDirGlob}/**/.gitignore`, { excludeDirectories: ['templates'] });
    this.remove(gitignore, '.gitignore files');

    // Module .gitattributes not found in template directories
    const gitattributes = await find(`${baseDirGlob}/**/.gitattributes`, { excludeDirectories: ['templates'] });
    this.remove(gitattributes, '.gitattributes files');

    // Module .eslintrc not found in template directories
    const eslintrc = await find(`${baseDirGlob}/**/.eslintrc`, { excludeDirectories: ['templates'] });
    this.remove(eslintrc, '.eslintrc files');

    // Module appveyor.yml not found in template directories
    const appveyor = await find(`${baseDirGlob}/**/appveyor.yml`, { excludeDirectories: ['templates'] });
    this.remove(appveyor, 'appveyor.yml files');

    // Module circle.yml not found in template directories
    const circle = await find(`${baseDirGlob}/**/circle.yml`, { excludeDirectories: ['templates'] });
    this.remove(circle, 'circle.yml files');

    // Module test dirs, except in salesforce-alm, which includes production source code in such a dir
    const allowedTestDirs = [
      'command',
      'commands',
      'lib',
      'dist',
      'salesforce-alm',
      '@salesforce/plugin-templates',
      '@salesforce/plugin-generator',
    ];
    const testDirs = (await find(`${baseDirGlob}/**/test`, { onlyDirectories: true })).filter(
      (f) => !allowedTestDirs.some((d) => f.includes(d))
    );
    this.remove(testDirs, 'test directories');

    // JS map files, except the ill-named `lodash.map` (it's a directory and we'll also filter out matches if found for good measure)
    const maps = (await find(`${baseDirGlob}/**/*.map`)).filter((f) => !f.includes('lodash.map'));
    this.remove(maps, '*.map files');

    // In case yarn autoclean is disabled, delete some known windows file path length offenders
    const nycOutput = await find(`${baseDirGlob}/**/.nyc_output`);
    this.remove(nycOutput, '.nyc_output files');

    // Large files shipped with jsforce
    const jsforceBuild = await find(`${baseDirGlob}/jsforce/build`, { onlyDirectories: true });
    this.remove(jsforceBuild, 'jsforce/build directory');

    // This breaks compilation. We need to probably do this right before the pack, but then this will
    // break compilation the next time compile is ran without doing a yarn install --force
    // We don't need types in the production code
    if (this.flags.types) {
      const types = await find(`${baseDirGlob}/**/*.d.ts`);
      this.remove(types, '*.d.ts files');
    }
  }

  private remove(files: string[], type: string): void {
    if (!files.length) return;
    const msg = this.flags.dryrun
      ? `${red.bold('[DRYRUN] Removing:')} ${files.length} ${type}`
      : `${red.bold('Removing:')} ${files.length} ${type}`;
    this.log(msg);

    if (this.flags.verbose) {
      files.forEach((f) => this.log(`  ${f}`));
    }

    if (!this.flags.dryrun) {
      files.forEach((f) => rm('-rf', f));
    }
  }
}

const find = async (
  globPattern: string,
  options: fg.Options & { excludeDirectories?: string[] } = {}
): Promise<string[]> => {
  const patterns = [globPattern];
  if (options.excludeDirectories) {
    const parts = globPattern.split('/').slice();
    const lastPart = parts.pop();
    for (const dir of options.excludeDirectories) {
      const patternParts = parts.concat([dir, '**', lastPart ?? '']);
      const exclusionPattern = `!${patternParts.join('/')}`;
      patterns.push(exclusionPattern);
    }
  }
  if (options?.excludeDirectories) delete options.excludeDirectories;
  return fg(patterns, options);
};
