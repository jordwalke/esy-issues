#!/usr/bin/env node

/* @flow */
const fs = require('fs');
const path = require('path');
const packageResolve = require('resolve');

type scope =
|
"export"
| "global"
| "local";

type envVar = {
  key: string,
  val: string,
  scope?: string
};

type npmModule = {
  build: string,
  dependencies: { [key: string]: string },
  exportedEnvVars: { [key: string]: envVar },
  name: string,
  version: string
};

type esyEnvVar = {
  key: string,
  value: string,
  scope: [scope]
};

type esyPackage = {
  name: string,
  build: string,
  version: string,
  exportedEnvVars: [esyEnvVar],
  runtimeEnvVars:  [esyEnvVar],
  deps: [esyPackage],
  dependencies:  { [key: string]: string }
};

type _visitedDependencies = {
  [key: string]: boolean
};

let visitedDependencies: _visitedDependencies = {};

// get package.json of current folder or climbs up to closest one
function findRootPackageJSON(cf) {
  let currentFolder = cf;

  function resolver(resolve, reject) {
    const packageJSONpath = path.join(currentFolder, 'package.json');
    fs.exists(packageJSONpath, exists => {
      if (exists) {
        resolve(packageJSONpath);
      }
      else {
        const newCurrentFolder = path.resolve(currentFolder, '..');
        if (newCurrentFolder === '/') {
          reject('couldn\'t find a package.json in the current folder or any of the parent folders');
        }
        else {
          currentFolder = newCurrentFolder
          resolver(resolve, reject);
        }
      }
    });
  }

  return new Promise(resolver);
}

function resolvePackageJSON(pathName) {
  function resolver(resolve, reject) {
    fs.readFile(pathName, 'utf8', (err, data) => {
      if (err) {
        reject('Could not find ' + pathName);
      }
      else {
        try {
          var pack: npmModule = JSON.parse(data);
        }
        catch (e) {
          reject('Invalid JSON found at ' + pathName);
          return;
        }
        if (!pack.name) {
          reject('no package name declared in: ' + pathName);
        }
        const packEnvVars = pack.exportedEnvVars;
        const esyPackage: esyPackage = {
          name: pack.name,
          build: pack.build,
          version: pack.version,
          exportedEnvVars: packEnvVars ? Object.keys(packEnvVars).map(
            key => ({key: key, scope: packEnvVars[key].scope ? packEnvVars[key].scope.split('|') : [], value: packEnvVars[key].val})
          ) : [],
          runtimeEnvVars: [],
          dependencies: pack.dependencies,
          deps: []
        };
        const exportedEnvVars = esyPackage.exportedEnvVars;

        esyPackage.runtimeEnvVars = esyPackage.runtimeEnvVars.concat(exportedEnvVars.filter(({scope}) => scope.includes('local')));
        if (esyPackage.dependencies) {
          resolveDependencies({pathName, module: esyPackage})
            .then(({pathName, module, globalEnvVars}) => {
              let envVars = module.deps.map(pack => pack.exportedEnvVars);
              if (envVars.length) {
                envVars = envVars.reduce((a, b) => a.concat(b));
              }
              const exportedEnvVars = envVars.filter(envVar => envVar.scope.includes('export'));
              const globalEnvVars2 = globalEnvVars.concat(envVars.filter(envVar => envVar.scope.includes('global')));
              module.runtimeEnvVars = module.runtimeEnvVars.concat(exportedEnvVars).concat(globalEnvVars2);
              return {pathName, module, globalEnvVars: globalEnvVars2};
            })
            .then(resolve, reject);
        }
        else {
          resolve({pathName, module: esyPackage});
        }
      }
    });
  }

  return new Promise(resolver);
}

function resolveDependencies({pathName, module}) {
  // TODO: add support for peer and maybe others?!
  const depsPromises = !module.dependencies ? [] : Object.keys(module.dependencies).map(key => {
    if (!visitedDependencies[key]) {
      visitedDependencies[key] = true;
      return new Promise((resolve, reject) => {
        packageResolve(path.join(key, 'package.json'), {basedir: path.dirname(pathName)}, (err, res) => {
          if (err) {
            reject('Could not find dependency ' + key + ', perhaps you need to run `npm install`?')
          }
          else {
            resolvePackageJSON(res).then(resolve, reject);
          }
        });
      });
    }
  });
  return Promise.all(depsPromises)
    .then((resolvedDeps: [{module: npmModule, globalEnvVars:[esyEnvVar]}]) => {
      module.deps = resolvedDeps.map(dependency => dependency.module);
      let globalEnvVars = resolvedDeps.map(dep => dep.globalEnvVars || []);
      if (globalEnvVars.length) {
        globalEnvVars = globalEnvVars.reduce((envVarA, envVarB) => envVarA.concat(envVarB));
      }
      else {
        globalEnvVars = [];
      }
      return {pathName, module, globalEnvVars};
    });
}

const util = require('util');
function printCurrentSandBox({pathName, module}) {
  console.log(util.inspect(module, {showHidden: false, depth: null}))
}

const processedBuildTasks: _visitedDependencies = {};
function createBuildTask({pathName, module}) {
  if (!processedBuildTasks[module.name]) {
    processedBuildTasks[module.name] = true;
    const childBuildTasks = module.deps.map(m => createBuildTask({pathName: null, module: m})).join('');
    const buildDeps = module.deps.map(m => m.name);
    let buildTask = childBuildTasks + (buildDeps.length ? module.name + ' : ' + buildDeps.join(' ') : module.name) + '\n';
    buildTask += module.runtimeEnvVars.map(envVar => '\texport ' + envVar.key + '=' + envVar.value).join('\n') + '\n\t' + module.build + '\n\n';
    if (pathName) {
      buildTask += 'default: ' + module.name;
    }
    return buildTask;
  }
  else {
    return '';
  }
}

findRootPackageJSON(process.cwd())
  .then(resolvePackageJSON)
  .then(createBuildTask)
  .then(a => console.info(a))
  .catch((err: string) => console.info('error:', err));
