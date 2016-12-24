/**
 * @flow
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const parseYarnLockfile = require('yarn/lib/lockfile/parse').default;
const resolveSync = require('resolve').sync;
const {mapObject} = require('./Utility');

/**
 * Represents sandbox state.
 *
 * Sandbox declaration:
 *
 *    {
 *      env: env,
 *      packageInfo: packageInfo
 *    }
 *
 * Environment override:
 *
 *    {
 *      env: env {
 *        esy__target_architecture: 'arm'
 *      },
 *      packageInfo: packageInfo
 *    }
 *
 */
export type Sandbox = {
  env: Environment;
  packageInfo: PackageInfo;
};

/**
 * Sandbox build environment is a set of k-v pairs.
 */
export type Environment = {[name: string]: string};

export type PackageInfo = {
  source: string;
  normalizedName: string;
  rootDirectory: string;
  packageJson: PackageJson;
  dependencyTree: DependencyTree;
};

export type PackageJsonVersionSpec = {
  [name: string]: string;
};

export type EnvironmentVarExport = {
  val: string;
  scope?: string;
  exclusive?: boolean;
  __BUILT_IN_DO_NOT_USE_OR_YOU_WILL_BE_PIPd?: boolean;
};

export type PackageJson = {
  name: string;
  version?: string;
  dependencies?: PackageJsonVersionSpec;
  peerDependencies?: PackageJsonVersionSpec;
  devDependencies?: PackageJsonVersionSpec;
  optionalDependencies?: PackageJsonVersionSpec;

  pjc?: {
    build?: string;
  };

  exportedEnvVars?: {
    [name: string]: EnvironmentVarExport;
  }
};

export type DependencyTree = {
  [dependencyName: string]: PackageInfo;
};

type YarnLockfile = {
  [dependencySpec: string]: {
    version: string;
    resolved: string;
    dependencies?: {
      [name: string]: string;
    };
  };
};

function fromDirectory(directory: string): Sandbox {
  const source = path.resolve(directory);
  const env = getEnvironment();
  const packageJson = readJson(path.join(directory, 'package.json'));
  const lockfile = readPackageTreeFromYarnLockfile(path.join(directory, 'yarn.lock'));
  const dependencyTree = buildDependencyTreeFromLockfile(
    source,
    lockfile,
    objectToDependencySpecList(
      packageJson.dependencies,
      packageJson.peerDependencies
    )
  );
  return {
    env,
    packageInfo: {
      source,
      normalizedName: normalizeName(packageJson.name),
      rootDirectory: source,
      packageJson,
      dependencyTree,
    }
  };
}

/**
 * Traverse package dependency tree.
 */
function traversePackageDependencyTree(
  packageInfo: PackageInfo,
  handler: (packageInfo: PackageInfo) => *
): void {
  let seen = new Set();
  traversePackageDependencyTreeImpl(
    packageInfo,
    seen,
    handler
  );
}

function traversePackageDependencyTreeImpl(
  packageInfo,
  seen,
  handler
) {
  let {dependencyTree} = packageInfo;
  for (let dependencyName in dependencyTree) {
    if (seen.has(dependencyName)) {
      continue;
    }
    seen.add(dependencyName);
    traversePackageDependencyTreeImpl(
      dependencyTree[dependencyName],
      seen,
      handler
    );
  }
  handler(packageInfo)
}

function collectTransitiveDependencies(
  packageInfo: PackageInfo,
  seen: Set<string> = new Set()
): Array<PackageInfo> {
  let packageJson = packageInfo.packageJson;
  let dependencies = Object.keys(packageInfo.dependencyTree);
  let result = [];
  for (let depName of dependencies) {
    let dep = packageInfo.dependencyTree[depName];
    seen.add(depName);
    result.push(dep);
    result = result.concat(collectTransitiveDependencies(dep, seen));
  }
  return result;
}

function getEnvironment() {
  let platform = process.platform;
  let architecture = process.arch;
  return {
    'PATH': '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    'SHELL': 'env -i /bin/bash --norc --noprofile',

    // platform and architecture of the host machine
    'esy__platform': platform,
    'esy__architecture': architecture,

    // platform and architecture of the target machine, so that we can do cross
    // compilation
    'esy__target_platform': platform,
    'esy__target_architecture': architecture,
  };
}

function buildDependencyTreeFromLockfile(
  baseDir: string,
  lockfile: YarnLockfile,
  dependencySpecList: Array<string>
): DependencyTree {
  let dependencyTree: {[name: string]: PackageInfo} = {};
  for (let dependencySpec of dependencySpecList) {
    let dependencyInfo = lockfile[dependencySpec];
    if (dependencyInfo == null) {
      throw new Error(
        `package.json defines a dependency ${dependencySpec} but ` +
        `yarn.lock doesn't a record about it`
      );
    }
    let {name} = parseDependencySpec(dependencySpec);
    let dependencyPackageJsonPath  = resolveSync(
      `${name}/package.json`, {basedir: baseDir});
    let dependencyBaseDir = path.dirname(dependencyPackageJsonPath);
    let rootDirectory = dependencyBaseDir;
    let packageJson = readJson(dependencyPackageJsonPath);
    dependencyTree[name] = {
      version: dependencyInfo.version,
      // TODO: resolved === undefined for local deps in yarn.lock?
      source: dependencyInfo.resolved || rootDirectory,
      rootDirectory,
      packageJson,
      normalizedName: normalizeName(packageJson.name),
      dependencyTree: dependencyInfo.dependencies
        ? buildDependencyTreeFromLockfile(
            dependencyBaseDir,
            lockfile,
            objectToDependencySpecList(dependencyInfo.dependencies)
          )
        : {}
    };
  }
  return dependencyTree;
}

function readJson(filename) {
  const data = fs.readFileSync(filename, 'utf8');
  return JSON.parse(data);
}

function readPackageTreeFromYarnLockfile(filename) {
  const data = fs.readFileSync(filename, 'utf8');
  return parseYarnLockfile(data);
}

function parseDependencySpec(spec: string): {name: string; versionSpec: string} {
  if (spec.startsWith('@')) {
    let [_, name, versionSpec] = spec.split('@', 3);
    return {name: '@' + name, versionSpec};
  } else {
    let [name, versionSpec] = spec.split('@');
    return {name, versionSpec};
  }
}

function objectToDependencySpecList(...objs) {
  let dependencySpecList = [];
  for (let obj of objs) {
    if (obj == null) {
      continue;
    }
    for (let name in obj) {
      let versionSpec = obj[name];
      let dependencySpec = `${name}@${versionSpec}`;
      if (dependencySpecList.indexOf(dependencySpec) === -1) {
        dependencySpecList.push(dependencySpec);
      }
    }
  }
  return dependencySpecList;
}

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/@/g, '')
    .replace(/\//g, '_')
    .replace(/\-/g, '_');
}

function packageInfoKey(env: Environment, packageInfo: PackageInfo) {
  let {name, version, pjc, exportedEnvVars} = packageInfo.packageJson;
  let h = hash({
    env,
    packageInfo: {
      packageJson: {
        name, version, pjc, exportedEnvVars,
      },
      dependencyTree: mapObject(packageInfo.dependencyTree, dep => hash(env, dep)),
    },
  });
  return `${h}-${name}-${version || '0.0.0'}`;
}

function hash(value: mixed) {
  if (typeof value === 'object') {
    if (value === null) {
      return hash("null");
    } else if (!Array.isArray(value)) {
      const v = value;
      let keys = Object.keys(v);
      keys.sort();
      return hash(keys.map(k => [k, v[k]]));
    } else {
      return hash(JSON.stringify(value.map(hash)));
    }
  } else if (value === undefined) {
    return hash('undefined');
  } else {
    let hasher = crypto.createHash('sha1');
    hasher.update(JSON.stringify(value));
    return hasher.digest('hex');
  }
}

module.exports = {
  fromDirectory,
  traversePackageDependencyTree,
  collectTransitiveDependencies,
  packageInfoKey,
};
