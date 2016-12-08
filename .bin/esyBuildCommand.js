/**
 * @flow
 */

import type {PackageDb} from '../lib/PackageDb';
import type {MakeRawItem, MakeDefine, MakeRule} from '../lib/Makefile';

const childProcess = require('child_process');
const path = require('path');

const {
  traversePackageDb,
  collectTransitiveDependencies,
  collectDependencies,
} = require('../lib/PackageDb');
const PackageEnvironment = require('../lib/PackageEnvironment');
const Makefile = require('../lib/Makefile');

const ESY_SANDBOX_REF = '$(ESY__SANDBOX)';

function installDir(pkgName, ...args) {
  return path.join(
    '$(ESY__SANDBOX)', '_install', 'node_modules', pkgName, ...args);
}

function buildDir(pkgName, ...args) {
  return path.join(
    '$(ESY__SANDBOX)', '_build', 'node_modules', pkgName, ...args);
}

function envToEnvList(env) {
  return env.envVars.map(env => ({
    name: env.name,
    value: env.normalizedVal
  }));
}

function buildCommand(packageDb: PackageDb, args: Array<string>) {

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
      name: '*** Remove build artifacts ***',
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
    (packageJsonFilePath, packageJson) => {

      let allDependencies = collectTransitiveDependencies(packageDb, packageJson.name);

        let buildEnvironment = getBuildEnv(packageDb, packageJson.name);
        let exportedEnvironment = PackageEnvironment.calculateEnvironment(
          packageDb,
          packageJson.name
        );
        for (let group of exportedEnvironment) {
          buildEnvironment = buildEnvironment.concat(envToEnvList(group));
        }

      let findlibPath = allDependencies
        .map(dep => installDir(dep, 'lib'))
        .join(':');

      // Macro
      prelude.push({
        type: 'define',
        name: `${packageJson.name}__FINDLIB_CONF`,
        value: `
  path = "${findlibPath}"
  destdir = "${installDir(packageJson.name, 'lib')}"
        `.trim(),
      });

      prelude.push({
        type: 'define',
        name: `${packageJson.name}__ENV`,
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
        exportEnv: ['ESY__SANDBOX', `${packageJson.name}__FINDLIB_CONF`],
        command: `
mkdir -p $(@D)
echo "$${packageJson.name}__FINDLIB_CONF" > $(@);
        `.trim(),
      });

      rules.push({
        type: 'rule',
        name: `*** ${packageJson.name} shell ***`,
        target: `${packageJson.name}.shell`,
        exportEnv: ['ESY__SANDBOX'],
        command: `$(${packageJson.name}__ENV)\\\n(cd $cur__root && $SHELL)`,
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
          command: `
if [ ! -d "${installDir(packageJson.name)}" ]; then \\
  $(${packageJson.name}__ENV)\\\n  (cd $cur__root && ${buildCommand}); \\
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
$(${packageJson.name}__ENV)\\\n(cd $cur__root && ${buildCommand}); \\
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

function getPkgEnv(packageDb, packageName, asCurrent = false) {
  let {packageJson, packageJsonFilePath} = packageDb.packagesByName[packageName];
  let prefix = asCurrent ? 'cur' : packageJson.name;
  return [
    {
      name: `${prefix}__name`,
      value: packageJson.name,
    },
    {
      name: `${prefix}__version`,
      value: packageJson.version,
    },
    {
      name: `${prefix}__root`,
      value: path.dirname(packageJsonFilePath),
    },
    {
      name: `${prefix}__depends`,
      value: collectDependencies(packageDb, packageName).join(' '),
    },
    {
      name: `${prefix}__target_dir`,
      value: `$esy__build_tree/node_modules/${packageJson.name}`,
    },
    {
      name: `${prefix}__install`,
      value: `$esy__install_tree/node_modules/${packageJson.name}`,
    },
    {
      name: `${prefix}__bin`,
      value: `$esy__install_tree/node_modules/${packageJson.name}/bin`,
    },
    {
      name: `${prefix}__sbin`,
      value: `$esy__install_tree/node_modules/${packageJson.name}/sbin`,
    },
    {
      name: `${prefix}__lib`,
      value: `$esy__install_tree/node_modules/${packageJson.name}/lib`,
    },
    {
      name: `${prefix}__man`,
      value: `$esy__install_tree/node_modules/${packageJson.name}/man`,
    },
    {
      name: `${prefix}__doc`,
      value: `$esy__install_tree/node_modules/${packageJson.name}/doc`,
    },
    {
      name: `${prefix}__stublibs`,
      value: `$esy__install_tree/node_modules/${packageJson.name}/stublibs`,
    },
    {
      name: `${prefix}__toplevel`,
      value: `$esy__install_tree/node_modules/${packageJson.name}/toplevel`,
    },
    {
      name: `${prefix}__share`,
      value: `$esy__install_tree/node_modules/${packageJson.name}/share`,
    },
    {
      name: `${prefix}__etc`,
      value: `$esy__install_tree/node_modules/${packageJson.name}/etc`,
    },
  ];
}

function getBuildEnv(packageDb, packageName) {
  let {packageJson, packageJsonFilePath} = packageDb.packagesByName[packageName];
  let name = packageJson.name;
  let dependencies = collectDependencies(packageDb, packageName);
  let pkgEnv = [];

  pkgEnv = pkgEnv.concat([
    {
      name: 'esy__sandbox',
      value: '$ESY__SANDBOX',
    },
    {
      name: 'esy__install_tree',
      value: '$esy__sandbox/_install',
    },
    {
      name: 'esy__build_tree',
      value: '$esy__sandbox/_build',
    },
    {
      name: 'OCAMLFIND_CONF',
      value: `$esy__build_tree/node_modules/${name}/findlib.conf`,
    },
  ]);

  pkgEnv = pkgEnv.concat(
    getPkgEnv(packageDb, packageName, true),
    getPkgEnv(packageDb, packageName, false)
  );

  if (dependencies.length > 0) {
    pkgEnv = pkgEnv.concat(
      ...dependencies.map(dep => getPkgEnv(packageDb, dep, false))
    );
    let depPath = dependencies.map(dep => `$esy__install_tree/${dep}/bin`).join(':');
    let depManPath = dependencies.map(dep => `$esy__install_tree/${dep}/man`).join(':');
    pkgEnv = pkgEnv.concat([
      {
        name: 'PATH',
        value: `${depPath}:$PATH`,
      },
      {
        name: 'MAN_PATH',
        value: `${depManPath}:$MAN_PATH`,
      }
    ]);
  }

  return pkgEnv;
}

module.exports = buildCommand;
