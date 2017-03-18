/**
 * @flow
 */

const crypto = require('crypto');
const fs = require('mz/fs');
const path = require('path');
const outdent = require('outdent');
const resolveBase = require('resolve');
const {mapObject} = require('./Utility');

async function resolve(packageName, baseDirectory): Promise<string> {
  return new Promise((resolve, reject) => {
    resolveBase(packageName, {basedir: baseDirectory}, (err, resolution) => {
      if (err) {
        reject(err);
      } else {
        resolve(resolution);
      }
    });
  });
}

async function resolveToRealpath(packageName, baseDirectory) {
  let resolution = await resolve(packageName, baseDirectory);
  return fs.realpath(resolution);
}

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
  looseEnv: Environment;
  packageInfo: PackageInfo;
};

/**
 * Sandbox build environment is a set of k-v pairs.
 */
export type Environment = {[name: string]: string};

export type PackageInfo = {
  source: string;
  sourceType: 'remote' | 'local',
  normalizedName: string;
  rootDirectory: string;
  packageJson: PackageJson;
  dependencyTree: DependencyTree;
  errors: Array<{message: string}>;

  __cachedPackageHash?: string;
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

export type EsyConfig = {
  build: ?string;
  buildsInSource: boolean;
  exportedEnv: {
    [name: string]: EnvironmentVarExport;
  }
};

export type PackageJson = {
  name: string;
  version?: string;
  dependencies?: PackageJsonVersionSpec;
  peerDependencies?: PackageJsonVersionSpec;
  devDependencies?: PackageJsonVersionSpec;
  conditionalDependencies?: PackageJsonVersionSpec;
  optionalDependencies?: PackageJsonVersionSpec;

  // This is specific to npm, make sure we get rid of that if we want to port to
  // other package installers.
  //
  // npm puts a resolved name there, for example for packages installed from
  // github — it would be a URL to git repo and a sha1 hash of the tree.
  _resolved?: string;

  esy: EsyConfig;
};

export type DependencyTree = {
  [dependencyName: string]: PackageInfo;
};


type SandboxBuildContext = {
  packageDependencyTrace: Array<{name: string; packageDirectory: string}>;
  buildPackageInfo: (string, SandboxBuildContext) => Promise<PackageInfo>;
  resolve: (string, string) => Promise<string>;
};

type PackageDependency = {
  type: 'regular' | 'peer' | 'conditional';
  name: string;
  requirement: string;
}

function getDependencies(packageJson: PackageJson): Array<PackageDependency> {
  const {
    dependencies = {},
    peerDependencies = {},
    conditionalDependencies = {}
  } = packageJson;

  const result = [];
  const seen = new Set();

  function forEachDependency(dependencies, fn) {
    for (let name in dependencies) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      fn(name, dependencies[name]);
    }
  }

  forEachDependency(packageJson.dependencies, (name, requirement) => {
    result.push({type: 'regular', name, requirement});
  });

  forEachDependency(packageJson.peerDependencies, (name, requirement) => {
    result.push({type: 'peer', name, requirement});
  });

  forEachDependency(packageJson.conditionalDependencies, (name, requirement) => {
    result.push({type: 'conditional', name, requirement});
  });

  return result;
}

async function fromDirectory(directory: string): Promise<Sandbox> {
  const source = path.resolve(directory);
  const env = getEnvironment();
  const looseEnv = {...env};
  delete looseEnv.PATH;
  delete looseEnv.SHELL;
  const packageJson = await readPackageJson(path.join(directory, 'package.json'));

  const dependencies  = getDependencies(packageJson)

  if (dependencies.length > 0) {

    const resolveCache: Map<string, Promise<string>> = new Map();

    async function resolveWithCache(packageName, baseDir): Promise<string> {
      let key = `${baseDir}__${packageName}`;
      let resolution = resolveCache.get(key);
      if (resolution == null) {
        resolution = resolveToRealpath(packageName, baseDir);
        resolveCache.set(key, resolution);
      }
      return resolution;
    }

    const packageInfoCache: Map<string, Promise<PackageInfo>> = new Map();

    async function buildPackageInfoWithCache(baseDirectory, context): Promise<PackageInfo> {
      let packageInfo = packageInfoCache.get(baseDirectory);
      if (packageInfo == null) {
        packageInfo = buildPackageInfo(baseDirectory, context);
        packageInfoCache.set(baseDirectory, packageInfo);
      }
      return packageInfo;
    }

    const [dependencyTree, errors] = await buildDependencyTree(
      source,
      dependencies,
      {
        resolve: resolveWithCache,
        buildPackageInfo: buildPackageInfoWithCache,
        packageDependencyTrace: [{name: packageJson.name, packageDirectory: source}],
      }
    );

    return {
      env,
      looseEnv,
      packageInfo: {
        source: `local:${await fs.realpath(source)}`,
        sourceType: 'local',
        normalizedName: normalizeName(packageJson.name),
        rootDirectory: source,
        packageJson,
        dependencyTree,
        errors,
      }
    };
  } else {
    return {
      env,
      looseEnv,
      packageInfo: {
        source: `local:${await fs.realpath(source)}`,
        sourceType: 'local',
        normalizedName: normalizeName(packageJson.name),
        rootDirectory: source,
        packageJson,
        dependencyTree: {},
        errors: [],
      }
    };
  }
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
    if (seen.has(depName)) {
      continue;
    }
    seen.add(depName);
    result.push(dep);
    result = result.concat(collectTransitiveDependencies(dep, seen));
  }
  return result;
}

function getEnvironment() {
  let platform = process.env.ESY__TEST ? 'platform' : process.platform;
  let architecture = process.env.ESY__TEST ? 'architecture' : process.arch;
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

async function buildDependencyTree(
  baseDir: string,
  dependencies: Array<PackageDependency>,
  context: SandboxBuildContext
): Promise<[DependencyTree, Array<{message: string}>]> {

  let dependencyTree: {[name: string]: PackageInfo} = {};
  let errors = [];
  let missingPackages = [];

  async function tryResolveInPaths(module, path) {
    try {
      return await context.resolve(module, path);
    } catch (_err) {
      return null;
    }
  }

  async function addToDependencyTree(name, packageJsonPath) {
    const packageInfo = await context.buildPackageInfo(packageJsonPath, context);
    errors = errors.concat(packageInfo.errors);
    dependencyTree[name] = packageInfo;
  }

  function seenPackage(name) {
    return context.packageDependencyTrace.find(item => item.name === name)
  }

  for (let dep of dependencies) {

    if (seenPackage(dep.name)) {
      errors.push({
        message: formatCircularDependenciesError(dep.name, context)
      });
      continue;
    }

    let dependencyPackageJsonPath = await tryResolveInPaths(`${dep.name}/package.json`, baseDir);
    if (dependencyPackageJsonPath == null) {
      if (dep.type !== 'conditional') {
        missingPackages.push(dep.name);
      }
      continue;
    }

    await addToDependencyTree(dep.name, dependencyPackageJsonPath);
  }

  if (missingPackages.length > 0) {
    errors.push({
      message: formatMissingPackagesError(missingPackages, context)
    });
  }

  return [dependencyTree, errors];
}

async function buildPackageInfo(packageJsonPath, context) {
  const dependencyBaseDir = path.dirname(packageJsonPath);
  const packageJson = await readPackageJson(packageJsonPath);
  const [packageDependencyTree, packageErrors] = await buildDependencyTree(
    dependencyBaseDir,
    getDependencies(packageJson),
    {
      ...context,
      packageDependencyTrace: context.packageDependencyTrace.concat({
        name: packageJson.name,
        packageDirectory: path.dirname(packageJsonPath),
      })
    }
  );
  return {
    errors: packageErrors,
    version: packageJson.version,
    source: packageJson._resolved || `local:${await fs.realpath(dependencyBaseDir)}`,
    sourceType: packageJson._resolved ? 'remote' : 'local',
    rootDirectory: dependencyBaseDir,
    packageJson,
    normalizedName: normalizeName(packageJson.name),
    dependencyTree: packageDependencyTree,
  };
}

function formatMissingPackagesError(missingPackages, context) {
  let packagesToReport = missingPackages.slice(0, 3);
  let packagesMessage = packagesToReport.map(p => `"${p}"`).join(', ');
  let extraPackagesMessage = missingPackages.length > packagesToReport.length
    ? ` (and ${missingPackages.length - packagesToReport.length} more)`
    : '';
  return outdent`
    Cannot resolve ${packagesMessage}${extraPackagesMessage} packages
      at ${context.packageDependencyTrace.map(p => p.name).join(' -> ')}
      Did you forget to run "esy install" command?
  `
}

function formatCircularDependenciesError(dependency, context) {
  return outdent`
    Circular dependency "${dependency} detected
      at ${context.packageDependencyTrace.map(p => p.name).join(' -> ')}
  `
}


async function readJson(filename) {
  const data = await fs.readFile(filename, 'utf8');
  return JSON.parse(data);
}

async function readPackageJson(filename): Promise<PackageJson> {
  const packageJson = await readJson(filename);
  if (packageJson.esy == null) {
    packageJson.esy = {
      build: null,
      exportedEnv: {},
      buildsInSource: false,
    };
  }
  if (packageJson.esy.build == null) {
    packageJson.esy.build = null;
  }
  if (packageJson.esy.exportedEnv == null) {
    packageJson.esy.exportedEnv = {};
  }
  if (packageJson.esy.buildsInSource == null) {
    packageJson.esy.buildsInSource = false;
  }
  return packageJson;
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
  let {packageJson: {name, version, esy}, normalizedName, source} = packageInfo;
  if (packageInfo.__cachedPackageHash == null) {
    let h = hash({
      env,
      source,
      packageInfo: {
        packageJson: {
          name, version, esy
        },
        dependencyTree: mapObject(packageInfo.dependencyTree, (dep: PackageInfo) =>
          packageInfoKey(env, dep)),
      },
    });
    if (process.env.ESY__TEST) {
      packageInfo.__cachedPackageHash = `${normalizedName}-${version || '0.0.0'}`;
    } else {
      packageInfo.__cachedPackageHash = `${normalizedName}-${version || '0.0.0'}-${h}`;
    }
  }
  return packageInfo.__cachedPackageHash;
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
