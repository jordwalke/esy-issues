/**
 * @flow
 */

import type {MakeItem, MakeRawItem, MakeDefine, MakeRule} from './Makefile';
import type {
  Sandbox,
  PackageInfo
} from './Sandbox';

const childProcess = require('child_process');
const fs = require('fs');
const crypto  = require('crypto');
const path = require('path');
const outdent = require('outdent');

const RUNTIME = fs.readFileSync(require.resolve('./esyBuildRuntime.sh'), 'utf8');

const {
  traversePackageDependencyTree,
  collectTransitiveDependencies,
  packageInfoKey,
} = require('./Sandbox');
const PackageEnvironment = require('./PackageEnvironment');
const Makefile = require('./Makefile');

function buildEjectCommand(
  sandbox: Sandbox,
  args: Array<string>,
  options: {buildInStore?: boolean} = {buildInStore: true}
) {

  let sandboxPackageName = sandbox.packageInfo.packageJson.name;

  function targetPath(sandbox, packageInfo, tree: '_install' | '_build', ...path) {
    let packageName = packageInfo.packageJson.name;
    let packageKey = packageInfoKey(sandbox.env, packageInfo);
    let isRootPackage = packageName === sandbox.packageInfo.packageJson.name;
    if (isRootPackage) {
      return ['$(ESY__SANDBOX)', tree, ...path].join('/');
    }
    return options.buildInStore
      ? ['$(ESY__STORE)', tree, packageKey, ...path].join('/')
      : ['$(ESY__SANDBOX)', tree, 'node_modules', packageName, ...path].join('/');
  }

  function cachedBuildUrl(sandbox, packageInfo) {
    return [
      'https://github.com/andreypopp/esy/releases/download/build-cache/',
      '$cur__install_key',
      '.tar.gz'
    ].join('');
  }

  let prelude: Array<MakeDefine | MakeRawItem> = [
    {
      type: 'raw',
      value: 'ESY__MAKEFILE := $(lastword $(MAKEFILE_LIST))'
    },
    {
      type: 'raw',
      value: `SHELL = ${sandbox.env.SHELL}`,
    },
    {
      type: 'raw',
      value: 'ESY__STORE ?= $(HOME)/.esy/store',
    },
    {
      type: 'raw',
      value: `ESY__RUNTIME ?= $(HOME)/.esy/runtime-${hash(RUNTIME)}.sh`,
    },
    {
      type: 'raw',
      value: 'ESY__SANDBOX ?= $(CURDIR)',
    },
  ];

  let rules: Array<MakeItem> = [

    {
      type: 'rule',
      target: 'build',
      dependencies: [`${sandboxPackageName}.build`],
    },
    {
      type: 'rule',
      target: 'rebuild',
      dependencies: [`${sandboxPackageName}.rebuild`],
    },
    {
      type: 'rule',
      target: 'shell',
      dependencies: [`${sandboxPackageName}.shell`],
    },
    {
      type: 'rule',
      target: 'clean',
      command: 'rm -rf $(ESY__SANDBOX)/_build $(ESY__SANDBOX)/_install',
    },
    {
      type: 'rule',
      target: '$(ESY__STORE)/_install $(ESY__STORE)/_build $(ESY__STORE)/_logs',
      command: 'mkdir -p $(@)',
    },
    {
      type: 'rule',
      target: 'esy-store',
      dependencies: ['$(ESY__STORE)/_install',  '$(ESY__STORE)/_build', '$(ESY__STORE)/_logs'],
    },
    {
      type: 'rule',
      target: 'esy-runtime',
      dependencies: ['$(ESY__RUNTIME)'],
    },
    {
      type: 'file',
      name: '$(ESY__RUNTIME)',
      value: RUNTIME
    },
  ];

  traversePackageDependencyTree(
    sandbox.packageInfo,
    (packageInfo) => {
      let {normalizedName, packageJson} = packageInfo;

      /**
       * Produce a package-scoped Makefile rule which executes its command in
       * the package's environment and working directory.
       */
      function definePackageRule(rule: {
        target: string;
        dependencies?: Array<string>;
        command?: ?string;
      }) {
        let {
          target,
          command,
          dependencies = []
        } = rule;
        rules.push({
          type: 'rule',
          target: `${packageJson.name}.${target}`,
          dependencies: ['esy-store', 'esy-runtime', ...dependencies],
          command: command != null
            ? outdent`
              export ESY__STORE=$(ESY__STORE); \\
              export ESY__SANDBOX=$(ESY__SANDBOX); \\
              export ESY__RUNTIME=$(ESY__RUNTIME); \\
              export cur__install_key="${packageInfoKey(sandbox.env, packageInfo)}"; \\
              $(${normalizedName}__ENV)\\
              cd $cur__root; \\
              source $(ESY__RUNTIME); \\
              ${command}
            `
            : null
        });
      }

      let isRootPackage = packageJson.name === sandboxPackageName;
      let allDependencies = collectTransitiveDependencies(packageInfo);

      let buildEnvironment = PackageEnvironment.calculateEnvironment(
        sandbox,
        packageInfo,
        {buildInStore: options.buildInStore}
      );

      let dependencies = Object.keys(packageInfo.dependencyTree).map(dep => `${dep}.build`);

      // Produce macro with rendered findlib.conf content.
      let findlibPath = allDependencies
        .map(dep => targetPath(sandbox, dep, '_install', 'lib'))
        .join(':');

      rules.push({
        type: 'file',
        name: targetPath(sandbox, packageInfo, '_build', 'findlib.conf'),
        value: outdent`
          path = "${findlibPath}"
          destdir = "${targetPath(sandbox, packageInfo, '_install', 'lib')}"
        `
      });

      // Produce macro with rendered package's environment.
      prelude.push({
        type: 'define',
        name: `${normalizedName}__ENV`,
        value: Makefile.renderEnv(buildEnvironment),
      });

      definePackageRule({
        target: 'findlib.conf',
        dependencies: [targetPath(sandbox, packageInfo, '_build', 'findlib.conf')],
      });

      definePackageRule({
        target: 'clean',
        command: 'rm -rf $cur__install $cur__target_dir'
      });

      definePackageRule({
        target: 'shell',
        dependencies,
        command: 'esy-shell'
      });
      definePackageRule({
        target: 'build',
        dependencies: [
          `${packageJson.name}.findlib.conf`,
          ...dependencies
        ],
        command: isRootPackage
          ? 'esy-prepare-install-tree && esy-build-command'
          : 'esy-build'
      });
    });

  let allRules = [].concat(prelude).concat(rules);
  console.log(Makefile.renderMakefile(allRules));
}

function hash(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

module.exports = buildEjectCommand;
