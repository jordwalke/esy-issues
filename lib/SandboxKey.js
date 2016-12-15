/**
 * @flow
 */

const crypto = require('crypto');

import type {
  Sandbox,
  PackageInfo,
} from './Sandbox';

function computeSandboxKey(sandbox: Sandbox): string {
}

function objectCacheKey(obj: Object): string {
  let keys = Object.keys(obj);
  keys.sort();
  let normalizedObject = keys.map(key => [key, obj[key]]);
  return hash(normalizedObject);
}

function packageInfoCacheKey(
  envCacheKey: string,
  packageInfo: PackageInfo
): string {
  let {dependencyTree, packageJson, source} = packageInfo;
  let dependencyKeys = Object.keys(dependencyTree);
  dependencyKeys.sort();
  let dependencyTreeHash = dependencyKeys.map(key =>
    hash([
      key,
      packageInfoCacheKey(envCacheKey, dependencyTree[key])
    ])
  );
  return hash([
    envCacheKey,
    hash(source),
    packageJson.pjc
      ? objectCacheKey(packageJson.pjc)
      : null,
    packageJson.exportedEnvVars
      ? objectCacheKey(packageJson.exportedEnvVars)
      : null,
    hash(dependencyTreeHash),
  ]);
}

function sandboxCacheKey(sandbox: Sandbox) {
  let envCacheKey = objectCacheKey(sandbox.env);
  return hash([
    envCacheKey,
    packageInfoCacheKey(envCacheKey, sandbox.packageInfo),
  ]);
}

function hash(value: mixed) {
  let hasher = crypto.createHash('sha1');
  if (typeof value === 'string') {
    return hasher.update(value).digest('hex');
  } else if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return hash(value.map(hash));
    }
    if (value === null) {
      return hasher.update(value).digest('hex');
    }
    if (
      value.constructor &&
      value.constructor !== Object
    ) {
      throw new Error('cannot compute hash of the object with a custom prototype');
    }
  } else {
    hasher.update(JSON.stringify(value));
  }
  return hasher.digest('hex');
}

module.exports = {
  computeSandboxKey,
};

