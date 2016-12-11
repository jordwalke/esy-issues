/**
 * @flow
 */

import type {PackageDb} from './PackageDb';
import type {MakeRawItem, MakeDefine, MakeRule} from './Makefile';

const childProcess = require('child_process');
const path = require('path');

const {
  traversePackageDb,
  collectTransitiveDependencies,
  collectDependencies,
} = require('./PackageDb');
const PackageEnvironment = require('./PackageEnvironment');
const Makefile = require('./Makefile');

const ESY_SANDBOX_REF = '$(ESY__SANDBOX)';

function buildCommand(packageDb: PackageDb, args: Array<string>) {

  function installDir(pkgName, ...args) {
    let isRootPackage = pkgName === packageDb.rootPackageName;
    return isRootPackage
      ? path.join('$(ESY__SANDBOX)', '_install', ...args)
      : path.join('$(ESY__SANDBOX)', '_install', 'node_modules', pkgName, ...args);
  }

  function buildDir(pkgName, ...args) {
    let isRootPackage = pkgName === packageDb.rootPackageName;
    return isRootPackage
      ? path.join('$(ESY__SANDBOX)', '_build', ...args)
      : path.join('$(ESY__SANDBOX)', '_build', 'node_modules', pkgName, ...args);
  }

  let rules: Array<MakeRule> = [
    {
      type: 'rule',
      name: '*** Build root package ***',
      target: 'build',
      dependencies: [`${packageDb.rootPackageName}.build`],
    },
    {
      type: 'rule',
      name: '*** Rebuild root package ***',
      target: 'rebuild',
      dependencies: [`${packageDb.rootPackageName}.rebuild`],
    },
    {
      type: 'rule',
      name: '*** Root package shell ***',
      target: 'shell',
      dependencies: [`${packageDb.rootPackageName}.shell`],
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
      value: 'SHELL = /bin/bash',
    },
    {
      type: 'raw',
      value: 'ESY__SANDBOX ?= $(CURDIR)',
    },
  ];

  traversePackageDb(
    packageDb,
    ({normalizedName, packageJsonFilePath, packageJson}) => {

      let isRootPackage = packageJson.name === packageDb.rootPackageName;
      let allDependencies = collectTransitiveDependencies(packageDb, packageJson.name);

      let buildEnvironment = PackageEnvironment.calculateEnvironment(
        packageDb,
        packageJson.name
      );

      let findlibPath = allDependencies
        .map(dep => installDir(dep, 'lib'))
        .join(':');

      // Macro
      prelude.push({
        type: 'define',
        name: `${normalizedName}__FINDLIB_CONF`,
        value: `
  path = "${findlibPath}"
  destdir = "${installDir(packageJson.name, 'lib')}"
        `.trim(),
      });

      prelude.push({
        type: 'define',
        name: `${normalizedName}__ENV`,
        value: Makefile.renderEnv(buildEnvironment),
      });

      rules.push({
        type: 'rule',
        name: null,
        target: `${packageJson.name}.findlib.conf`,
        dependencies: [buildDir(packageJson.name, 'findlib.conf')],
        command: null,
      });

      rules.push({
        type: 'rule',
        name: null,
        target: buildDir(packageJson.name, 'findlib.conf'),
        exportEnv: ['ESY__SANDBOX', `${normalizedName}__FINDLIB_CONF`],
        command: `
mkdir -p $(@D)
echo "$${normalizedName}__FINDLIB_CONF" > $(@);
        `.trim(),
      });

      rules.push({
        type: 'rule',
        name: `*** ${packageJson.name} shell ***`,
        target: `${packageJson.name}.shell`,
        exportEnv: ['ESY__SANDBOX'],
        command: `$(${normalizedName}__ENV)\\\n(cd $cur__root && $SHELL)`,
      });

      rules.push({
        type: 'rule',
        name: `*** Clean ${packageJson.name} installation / build ***`,
        target: `${packageJson.name}.clean`,
        exportEnv: ['ESY__SANDBOX'],
        command: `$(${normalizedName}__ENV)\\\n(rm -rf $cur__install $cur__target_dir)`,
      });

      let dependencies = collectDependencies(packageDb, packageJson.name)
                         .map(dep => `${dep}.build`);

      if (packageJson.pjc && packageJson.pjc.build) {
        let buildCommand = packageJson.pjc.build;
        rules.push({
          type: 'rule',
          name: ` *** Build ${packageJson.name} ***`,
          target: `${packageJson.name}.build`,
          dependencies: [
            `${packageJson.name}.findlib.conf`,
            ...dependencies
          ],
          exportEnv: ['ESY__SANDBOX'],
          command: isRootPackage
          ?  `
$(${normalizedName}__ENV)\\
mkdir -p \\
  $cur__install $cur__lib $cur__bin \\
  $cur__sbin $cur__man $cur__doc \\
  $cur__share $cur__etc; \\
(cd $cur__root && ${buildCommand});
          `.trim()
          : `
if [ ! -d "${installDir(packageJson.name)}" ]; then \\
  $(${normalizedName}__ENV)\\
  mkdir -p \\
    $cur__install $cur__lib $cur__bin \\
    $cur__sbin $cur__man $cur__doc \\
    $cur__share $cur__etc; \\
  (cd $cur__root && ${buildCommand}); \\
fi
          `.trim(),
        });
        rules.push({
          type: 'rule',
          name: ` *** Rebuild ${packageJson.name} ***`,
          target: `${packageJson.name}.rebuild`,
          dependencies: [
            `${packageJson.name}.findlib.conf`,
            ...dependencies
          ],
          exportEnv: ['ESY__SANDBOX'],
          command: `
$(${normalizedName}__ENV)\\\n(cd $cur__root && ${buildCommand}); \\
          `.trim(),
        });
      } else {
        rules.push({
          type: 'rule',
          target: `${packageJson.name}.rebuild`,
          dependencies,
        });
        rules.push({
          type: 'rule',
          target: `${packageJson.name}.build`,
          dependencies,
        });
      }
    });

  let allRules = [].concat(prelude).concat(rules);
  console.log(Makefile.renderMakefile(allRules));
}

module.exports = buildCommand;
