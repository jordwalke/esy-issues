/**
 * @flow
 */

import type {PackageDb} from '../lib/PackageDb';
import type {MakeDefine, MakeRule} from '../lib/Makefile';

const childProcess = require('child_process');
const path = require('path');

const {
  traversePackageDb,
  collectTransitiveDependencies,
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

  ];

  let prelude: Array<MakeDefine> = [
    {
      type: 'define',
      name: 'ESY__SANDBOX',
      value: '$(PWD)',
      assignment: '?=',
    },
  ];

  traversePackageDb(
    packageDb,
    (packageJsonFilePath, packageJson) => {

      let dependencies = collectTransitiveDependencies(packageDb, packageJson.name);

      let findlibPath = dependencies
        .map(dep => installDir(dep, 'lib'))
        .join(':');

      prelude.push({
        type: 'define',
        name: `${packageJson.name}__FINDLIB_CONF`,
        value: `
  path = "$(shell ocamlfind printconf path):${findlibPath}"
  destdir = "${installDir(packageJson.name, 'lib')}"
        `.trim(),
      });

      rules.push({
        type: 'rule',
        name: null,
        target: `${packageJson.name}__findlib.conf`,
        dependencies: [buildDir(packageJson.name, 'findlib.conf')],
        env: [],
        exportEnv: [],
        command: null,
      });

      rules.push({
        type: 'rule',
        name: null,
        target: buildDir(packageJson.name, 'findlib.conf'),
        dependencies: [],
        env: [],
        exportEnv: ['ESY__SANDBOX', `${packageJson.name}__FINDLIB_CONF`],
        command: `
  mkdir -p $(@D)
  echo "$${packageJson.name}__FINDLIB_CONF" > $(@);
        `.trim(),
      });

      if (packageJson.pjc && packageJson.pjc.build) {
        let buildCommand = packageJson.pjc.build;
        let buildEnvironment = getBuildEnv(packageDb, packageJson.name);
        let exportedEnvironment = PackageEnvironment.calculateEnvironment(
          packageDb,
          packageJson.name
        );
        for (let group of exportedEnvironment) {
          buildEnvironment = buildEnvironment.concat(envToEnvList(group));
        }
        let dependencies = [
          `${packageJson.name}__findlib.conf`
        ];
        if (packageJson.dependencies) {
          dependencies = dependencies.concat(Object.keys(packageJson.dependencies));
        }
        rules.push({
          type: 'rule',
          name: ` *** Build ${packageJson.name} ***`,
          target: packageJson.name,
          dependencies: dependencies,
          exportEnv: ['ESY__SANDBOX'],
          env: buildEnvironment,
          command: buildCommand,
        });
      } else {
        // TODO: Returning an empty rule. Is that really what we want here?
        rules.push({
          type: 'rule',
          name: ` *** Build ${packageJson.name} ***`,
          target: packageJson.name,
          env: [],
          exportEnv: ['ESY__SANDBOX'],
          dependencies: packageJson.dependencies != null
            ? Object.keys(packageJson.dependencies)
            : [],
          command: null,
        });
      }
    });

  let allRules = [].concat(prelude).concat(rules);
  console.log(Makefile.renderMakefile(allRules));
}

function getPkgEnv(packageDb, packageName, current = false) {
  let {packageJson, packageJsonFilePath} = packageDb.packagesByName[packageName];
  let prefix = current ? 'cur' : (packageJson.name + '_');
  return [
    {
      name: `${prefix}_name`,
      value: packageJson.name,
    },
    {
      name: `${prefix}_version`,
      value: packageJson.version,
    },
    {
      name: `${prefix}_root`,
      value: path.dirname(packageJsonFilePath),
    },
    {
      name: `${prefix}_depends`,
      value: packageJson.dependencies != null
        // TODO: handle peerDependencies / optionalDependencies
        ? `"${Object.keys(packageJson.dependencies).join(' ')}"`
        : null,
    },
    {
      name: `${prefix}_target_dir`,
      value: `$_build_tree/node_modules/${packageJson.name}`,
    },
    {
      name: `${prefix}_install`,
      value: `$_install_tree/node_modules/${packageJson.name}/lib`,
    },
    {
      name: `${prefix}_bin`,
      value: `$_install_tree/${packageJson.name}/bin`,
    },
    {
      name: `${prefix}_sbin`,
      value: `$_install_tree/${packageJson.name}/sbin`,
    },
    {
      name: `${prefix}_lib`,
      value: `$_install_tree/${packageJson.name}/lib`,
    },
    {
      name: `${prefix}_man`,
      value: `$_install_tree/${packageJson.name}/man`,
    },
    {
      name: `${prefix}_doc`,
      value: `$_install_tree/${packageJson.name}/doc`,
    },
    {
      name: `${prefix}_stublibs`,
      value: `$_install_tree/${packageJson.name}/stublibs`,
    },
    {
      name: `${prefix}_toplevel`,
      value: `$_install_tree/${packageJson.name}/toplevel`,
    },
    {
      name: `${prefix}_share`,
      value: `$_install_tree/${packageJson.name}/share`,
    },
    {
      name: `${prefix}_etc`,
      value: `$_install_tree/${packageJson.name}/etc`,
    },
  ];
}

function getBuildEnv(packageDb, packageName) {
  let {packageJson, packageJsonFilePath} = packageDb.packagesByName[packageName];
  let name = packageJson.name;
  // TODO: handle peerDependencies also
  let dependencies = packageJson.dependencies != null
    ? Object.keys(packageJson.dependencies)
    : [];
  let pkgEnv = [];

  pkgEnv = pkgEnv.concat([
    {
      name: 'sandbox',
      value: '$ESY__SANDBOX',
    },
    {
      name: '_install_tree',
      value: '$sandbox/_install',
    },
    {
      name: '_build_tree',
      value: '$sandbox/_build',
    },
    {
      name: 'OCAMLFIND_CONF',
      value: `$_build_tree/node_modules/${name}/findlib.conf`,
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
    let depPath = dependencies.map(dep => `$_install_tree/${dep}/bin`).join(':');
    let depManPath = dependencies.map(dep => `$_install_tree/${dep}/man`).join(':');
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
