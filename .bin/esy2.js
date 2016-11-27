#!/usr/bin/env node

/* @flow */
const fs = require('fs');
const path = require('path');
const packageResolve = require('resolve');

type scope =
| "export"
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
  scope: [scope],
  owner: string
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
            key => ({key: key, owner: pack.name, scope: packEnvVars[key].scope ? packEnvVars[key].scope.split('|') : [], value: packEnvVars[key].val})
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
              else {
                envVars = [];
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

function createFindlibMetaFile() {

}

function createFindlibConfigFile() {

}

const processedBuildTasks: _visitedDependencies = {};
const obfuscateKey = '__esy_scope__' + Date.now(); // wow such smart tactics
function createBuildTask({pathName, module}) {
  if (!processedBuildTasks[module.name]) {
    processedBuildTasks[module.name] = true;
    const childBuildTasks = module.deps.map(m => createBuildTask({pathName: null, module: m})).join('');
    const buildDeps = module.deps.map(m => m.name);
    let buildTask = childBuildTasks + (buildDeps.length ? module.name + ' : ' + buildDeps.join(' ') : module.name) + '\n';

    //
    buildTask += '\t# Built-in environment variables\n';
    buildTask += '\texport ' + module.name + '_name=' + module.name + '\n';
    buildTask += '\texport ' + module.name + '_version=' + module.version + '\n';
    buildTask += '\texport ' + module.name + '__target_dir=.\n';
    buildTask += '\texport ' + module.name + '__install=_install/\n';
    buildTask += '\texport ' + module.name + '__root=sandbox/\n';
    buildTask += '\texport ' + module.name + '__depends=[' + buildDeps.toString() + ']\n';
    buildTask += '\texport ' + module.name + '__bin=sandbox/' +  module.name + '/bin\n';
    buildTask += '\texport ' + module.name + '__sbin=sandbox/' +  module.name + '/sbin\n';
    buildTask += '\texport ' + module.name + '__lib=sandbox/' +  module.name + '/lib\n';
    buildTask += '\texport ' + module.name + '__man=sandbox/' +  module.name + '/man\n';
    buildTask += '\texport ' + module.name + '__doc=sandbox/' +  module.name + '/doc\n';
    buildTask += '\texport ' + module.name + '__stublibs=sandbox/' +  module.name + '/stublibs\n';
    buildTask += '\texport ' + module.name + '__toplevel=sandbox/' +  module.name + '/toplevel\n';
    buildTask += '\texport ' + module.name + '__share=sandbox/' +  module.name + '/share\n';
    buildTask += '\texport ' + module.name + '__etc=sandbox/' +  module.name + '/etc\n\n';

    const importedEnvVars = module.runtimeEnvVars.filter(envVar => envVar.scope.includes('global') || envVar.scope.includes('export'));
    const exportedEnvVars = module.exportedEnvVars;
    const localEnvVars = module.exportedEnvVars.filter(envVar => envVar.scope.includes('local'));

    if (exportedEnvVars.length) {
      buildTask += '\t# Exported environment variabless\n';
      buildTask += exportedEnvVars.map(envVar => '\texport ' + envVar.owner + '__' + envVar.key + '__' + obfuscateKey + '=' + envVar.value).join('\n') + '\n\n';
    }

    if (importedEnvVars.length) {
      buildTask += '\t# Environment variables coming from dependencies\n';
      buildTask += importedEnvVars.map(envVar => '\texport ' + envVar.key + '=$' + envVar.owner + '__' + envVar.key + '__' + obfuscateKey).join('\n') + '\n\n';
    }

    if (module.build) {
      buildTask += '\t# Build command\n';
      buildTask += '\t./' + module.build + '\n\n';
    }

    if (importedEnvVars.length) {
      buildTask += '\t# Reset imported environment variables\n';
      buildTask += importedEnvVars.map(envVar => '\tunset ' + envVar.key).join('\n') + '\n\n';
    }

    if (pathName) {
      buildTask += '\t#TODO: Reset all other variables\n\n';
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
