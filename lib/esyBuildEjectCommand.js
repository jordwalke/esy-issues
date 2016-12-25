/**
 * @flow
 */

import type {MakeRawItem, MakeDefine, MakeRule} from './Makefile';
import type {
  Sandbox,
  PackageInfo
} from './Sandbox';

const childProcess = require('child_process');
const fs = require('fs');
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
      value: `SHELL = ${sandbox.env.SHELL} -e`,
    },
    {
      type: 'raw',
      value: 'ESY__STORE ?= $(HOME)/.esy/store',
    },
    {
      type: 'raw',
      value: 'ESY__RUNTIME ?= $(HOME)/.esy/runtime.sh',
    },
    {
      type: 'raw',
      value: 'ESY__SANDBOX ?= $(CURDIR)',
    },
    {
      type: 'define',
      name: 'ESY__RUNTIME_CONTENT',
      value: RUNTIME,
    },
    {
      type: 'raw',
      value: 'export ESY__RUNTIME_CONTENT',
    },
  ];

  let rules: Array<MakeRule> = [
    {
      type: 'rule',
      name: '*** Build root package ***',
      target: 'build',
      dependencies: [`${sandboxPackageName}.build`],
    },
    {
      type: 'rule',
      name: '*** Rebuild root package ***',
      target: 'rebuild',
      dependencies: [`${sandboxPackageName}.rebuild`],
    },
    {
      type: 'rule',
      name: '*** Root package shell ***',
      target: 'shell',
      dependencies: [`${sandboxPackageName}.shell`],
    },
    {
      type: 'rule',
      name: '*** Remove sandbox installations / build artifacts ***',
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
      type: 'rule',
      target: '$(ESY__RUNTIME)',
      dependencies: ['SHELL=/bin/bash'],
    },
    {
      type: 'rule',
      target: '$(ESY__RUNTIME)',
      command: outdent`
        mkdir -p $(@D)
        echo "$ESY__RUNTIME_CONTENT" > $(@)
      `
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
      function makePackageRule(rule: {
        target: string;
        dependencies?: Array<string>;
        command?: ?string;
      }) {
        let {
          target,
          command,
          dependencies = []
        } = rule;
        return {
          type: 'rule',
          name: `*** ${packageJson.name}: ${target} ***`,
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
        };
      }

      let isRootPackage = packageJson.name === sandboxPackageName;
      let allDependencies = collectTransitiveDependencies(packageInfo);

      let buildEnvironment = PackageEnvironment.calculateEnvironment(
        sandbox,
        packageInfo,
        {buildInStore: options.buildInStore}
      );

      // Produce macro with rendered findlib.conf content.
      let findlibPath = allDependencies
        .map(dep => targetPath(sandbox, dep, '_install', 'lib'))
        .join(':');

      prelude.push({
        type: 'define',
        name: `${normalizedName}__FINDLIB_CONF`,
        value: outdent`
          path = "${findlibPath}"
          destdir = "${targetPath(sandbox, packageInfo, '_install', 'lib')}"
        `
      });
      prelude.push({
        type: 'raw',
        value : `export ${normalizedName}__FINDLIB_CONF`,
      });

      // Produce macro with rendered package's environment.
      prelude.push({
        type: 'define',
        name: `${normalizedName}__ENV`,
        value: Makefile.renderEnv(buildEnvironment),
      });

      rules.push({
        type: 'rule',
        name: null,
        target: targetPath(sandbox, packageInfo, '_build', 'findlib.conf'),
        dependencies: ['SHELL=/bin/bash'],
      });
      rules.push({
        type: 'rule',
        name: null,
        target: targetPath(sandbox, packageInfo, '_build', 'findlib.conf'),
        command: outdent`
          mkdir -p $(@D)
          echo "$${normalizedName}__FINDLIB_CONF" > $(@);
        `
      });

      rules.push(makePackageRule({
        target: 'findlib.conf',
        dependencies: [targetPath(sandbox, packageInfo, '_build', 'findlib.conf')],
      }));

      rules.push(makePackageRule({
        target: 'clean',
        command: 'rm -rf $cur__install $cur__target_dir'
      }));

      let dependencies = Object.keys(packageInfo.dependencyTree).map(dep => `${dep}.build`);

      rules.push(makePackageRule({
        target: 'shell',
        dependencies,
        command: 'esy-shell'
      }));

      rules.push(makePackageRule({
        target: 'build-archive',
        dependencies: [`${packageJson.name}.build`],
        command: 'esy-build-archive'
      }));

      if (packageJson.pjc && packageJson.pjc.build) {
        let buildCommand = packageJson.pjc.build;
        rules.push(makePackageRule({
          target: 'build',
          dependencies: [
            `${packageJson.name}.findlib.conf`,
            ...dependencies
          ],
          command: isRootPackage
            ? 'esy-prepare-install-tree && esy-build-command'
            : 'esy-build'
        }));
        rules.push(makePackageRule({
          target: 'rebuild',
          dependencies: [
            `${packageJson.name}.findlib.conf`,
            ...dependencies
          ],
          command: 'esy-prepare-install-tree && esy-build-command',
        }));
      } else {
        rules.push(makePackageRule({
          target: 'rebuild',
          dependencies,
        }));
        rules.push(makePackageRule({
          target: 'build',
          dependencies,
        }));
      }
    });

  let allRules = [].concat(prelude).concat(rules);
  console.log(Makefile.renderMakefile(allRules));
}

module.exports = buildEjectCommand;
