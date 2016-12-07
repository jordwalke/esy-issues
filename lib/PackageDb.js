/**
 * @flow
 */

const resolve = require('resolve');
const path = require('path');
const fs = require('fs');

export type PackageJsonVersionSpec = {
  [name: string]: string;
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
    [name: string]: {
      val: string;
      scope?: string;
      exclusive?: boolean;
      __BUILT_IN_DO_NOT_USE_OR_YOU_WILL_BE_PIPd?: boolean;
    };
  }
};

export type PackageDb = {
  path: string;
  rootPackageName: string;
  packagesByName: {
    [name: string]: {
      packageJsonFilePath: string;
      packageJson: PackageJson;
    };
  };
};

const KEYS = [
  'dependencies',
  'peerDependencies',
];

/**
 * Create a package database from a given directory.
 */
function fromDirectory(dir: string): PackageDb {

  const packageJsonFilePath = path.join(dir, 'package.json');

  if (!fs.existsSync(packageJsonFilePath)) {
    throw new Error(
      `Invalid sandbox: no ${path.relative(process.cwd(), packageJsonFilePath)} ` +
      `found. Every valid sandbox must have one.`
    )
  }

  const packagesByName = {};
  let rootPackageName = null;

  traversePackageTreeOnFileSystemSync(
    path.join(dir, 'package.json'),
    (packageJsonFilePath, packageJson) => {
      rootPackageName = packageJson.name;
      packagesByName[packageJson.name] = {
        packageJsonFilePath,
        packageJson,
      };
    });

  if (rootPackageName == null) {
    throw new Error('empty package db');
  }

  return {
    path: dir,
    rootPackageName,
    packagesByName,
  };
}

function collectTransitiveDependencies(
  packageDb: PackageDb,
  packageName: string
): Array<string> {
  let packageInfo = packageDb.packagesByName[packageName];
  if (packageInfo == null) {
    throw new Error(`Unknown package: ${packageName}`);
  }
  let packageJson = packageInfo.packageJson;
  // TODO: handle peerDependencies / optionalDependencies
  if (packageJson.dependencies == null) {
    return [];
  } else {
    let dependencies = Object.keys(packageJson.dependencies || {});
    let set = new Set(dependencies);
    for (let dep of dependencies) {
      for (let subdep of collectTransitiveDependencies(packageDb, dep)) {
        set.add(subdep);
      }
    }
    return Array.from(set);
  }
}

function traversePackageDb(
  packageDb: PackageDb,
  handler: (packageJsonFilePath: string, packageJson: PackageJson) => *
) {
  let {
    packageJsonFilePath,
    packageJson
  } = packageDb.packagesByName[packageDb.rootPackageName];
  let seen = new Set();
  traversePackageDbImpl(
    packageJsonFilePath,
    packageJson,
    seen,
    packageDb,
    handler
  );
}

function traversePackageDbImpl(
  packageJsonFilePath,
  packageJson,
  seen,
  packageDb,
  handler
) {
  let dependencies =
    Object.keys(packageJson.dependencies || {}).concat(
      Object.keys(packageJson.peerDependencies || {}))
  for (let depName of dependencies) {
    if (seen.has(depName)) {
      continue;
    }
    seen.add(depName);
    let depPackageInfo = packageDb.packagesByName[depName];
    traversePackageDbImpl(
      depPackageInfo.packageJsonFilePath,
      depPackageInfo.packageJson,
      seen,
      packageDb,
      handler
    );
  }
  handler(packageJsonFilePath, packageJson)
}

function traversePackageTreeOnFileSystemSync(
  packageJsonPathOnEjectingHost,
  handler,
  visitedRealPaths = {}
) {
  const packageJsonPathOnEjectingHostRealPath = fs.realpathSync(packageJsonPathOnEjectingHost);
  const pkg = JSON.parse(fs.readFileSync(packageJsonPathOnEjectingHost, 'utf8'));
  if (!pkg.name) {
    throw ("no package name for package:" + packageJsonPathOnEjectingHost);
  }
  visitedRealPaths[pkg.name] = packageJsonPathOnEjectingHostRealPath;
  /**
   * How about the convention that `buildTimeOnlyDependencies` won't be
   * traversed transitively to compute environments. The primary use case is
   * that we generally only need a binary produced - or a dll.
   */
  KEYS.forEach((key) => {
    Object.keys(pkg[key] || {}).forEach((dependencyName) => {
      try {
        const resolved = resolve.sync(
          path.join(dependencyName, 'package.json'),
          {basedir: path.dirname(packageJsonPathOnEjectingHost)}
        );
        if (!visitedRealPaths[dependencyName]) {
          traversePackageTreeOnFileSystemSync(resolved, handler);
        } else {
          if (visitedRealPaths[dependencyName] !== fs.realpathSync(resolved)) {
            // Find a way to aggregate warnings.
            // console.warn(
            //   "While computing environment for " + pkg.name + ", found that there are two separate packages named " +
            //     dependencyName + " at two different real paths on disk. One is at " +
            //     visitedRealPaths[dependencyName] + " and the other at " + fs.realpathSync(resolved)
            // );
          }
        }
      } catch (err) {
        // We are forgiving on optional dependencies -- if we can't find them,
        // just skip them
        if (pkg["optionalDependencies"] && pkg["optionalDependencies"][dependencyName]) {
          return;
        }
        throw err;
      }
    })
  });
  handler(packageJsonPathOnEjectingHost, pkg);
}

module.exports = {
  fromDirectory,
  traversePackageDb,
  collectTransitiveDependencies,
};
