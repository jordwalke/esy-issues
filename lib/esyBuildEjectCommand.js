/**
 * @flow
 */

import type {MakeRawItem, MakeDefine, MakeRule} from './Makefile';
import type {
  Sandbox,
  PackageInfo
} from './Sandbox';

const childProcess = require('child_process');
const path = require('path');
const outdent = require('outdent');

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
  ];

  let prelude: Array<MakeDefine | MakeRawItem> = [
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
      value: 'ESY__SANDBOX ?= $(CURDIR)',
    },
    {
      type: 'define',
      name: 'ESY__PREPARE_CURRENT_INSTALL_TREE',
      value: outdent`
        mkdir -p \\
          $cur__install \\
          $cur__lib \\
          $cur__bin \\
          $cur__sbin \\
          $cur__man \\
          $cur__doc \\
          $cur__share \\
          $cur__etc;
      `,
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
          dependencies
        } = rule;
        return {
          type: 'rule',
          name: `*** ${packageJson.name}: ${target} ***`,
          target: `${packageJson.name}.${target}`,
          dependencies,
          command: command != null
            ? outdent`
              export ESY__STORE=$(ESY__STORE); \\
              export ESY__SANDBOX=$(ESY__SANDBOX); \\
              $(${normalizedName}__ENV)\\
              cd $cur__root; \\
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
        command: outdent`
          /bin/bash \\
            --noprofile \\
            --rcfile <(echo 'export PS1="[$cur__name sandbox] $ "')
          `,
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
          ? outdent`
            $(ESY__PREPARE_CURRENT_INSTALL_TREE)\\
            ${buildCommand}
          `
          : outdent`
            if [ ! -d "$cur__install" ]; then \\
              $(ESY__PREPARE_CURRENT_INSTALL_TREE)\\
              ${buildCommand}; \\
            fi
          `
        }));
        rules.push(makePackageRule({
          target: 'rebuild',
          dependencies: [
            `${packageJson.name}.findlib.conf`,
            ...dependencies
          ],
          command: outdent`
            $(ESY__PREPARE_CURRENT_INSTALL_TREE)\\
            ${buildCommand}
          `,
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
