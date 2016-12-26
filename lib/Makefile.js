/**
 * Utilities for programmatic Makefile genetation.
 *
 * @flow
 */

import type {EnvironmentGroup} from './PackageEnvironment';

const outdent = require('outdent');

export type MakeRule = {
  type: 'rule';
  target: string;
  env?: Array<EnvironmentGroup>;
  command?: ?string;
  dependencies?: Array<string>;
  exportEnv?: Array<string>;
};

export type MakeDefine = {
  type: 'define';
  name: string;
  value: string;
};

export type MakeFile = {
  type: 'file';
  name: string;
  value: string;
};

export type MakeRawItem = {|
  type: 'raw';
  value: string;
|};

export type MakeItem =
  | MakeRule
  | MakeFile
  | MakeDefine
  | MakeRawItem;

function renderMakefile(items: Array<MakeItem>) {
  return items
    .map(item => {
      if (item.type === 'rule') {
        return renderMakeRule(item);
      } else if (item.type === 'define') {
        return renderMakeDefine(item);
      } else if (item.type === 'raw') {
        return renderMakeRawItem(item);
      } else if (item.type === 'file') {
        return renderMakeFile(item);
      } else {
        throw new Error('Unknown make item:' + JSON.stringify(item));
      }
    })
    .join('\n\n');
}

function renderMakeDefine({name, value}) {
  return `define ${name}\n${escapeEnvVar(value)}\nendef`;
}

function renderMakeFile({name, value}) {
  let escapedName = escapeName(name);
  return outdent`
    define ${escapedName}__CONTENTS
    ${escapeEnvVar(value)}
    endef

    export ${escapedName}__CONTENTS

    ${name}: SHELL=/bin/bash
    ${name}:
    \tmkdir -p $(@D)
    \techo "$$${escapedName}__CONTENTS" > $(@)
  `;
}

function renderMakeRawItem({value}) {
  return value;
}

function renderMakeRule(rule) {
  let {
    target,
    dependencies = [],
    command,
    env,
    exportEnv,
  } = rule;
  let header = `${target}: ${dependencies.join(' ')}`;

  let prelude = '';
  if (exportEnv) {
    exportEnv.forEach(name => {
      prelude = prelude + `export ${name}\n`;
    });
  }

  if (command != null) {
    let recipe = escapeEnvVar(renderMakeRuleCommand({env, command}));
    return `${prelude}${header}\n${recipe}`;
  } else {
    return prelude + header;
  }
}

function renderMakeRuleCommand({env = [], command}) {
  command = command.split('\n').map(line => `\t${line}`).join('\n');
  if (env.length > 0) {
    return `@${renderEnvImpl(env)}\\\n${command}`;
  } else {
    return command;
  }
}

function renderEnv(groups: Array<EnvironmentGroup>): string {
  return renderEnvImpl(groups);
}

function renderEnvImpl(groups: Array<EnvironmentGroup>): string {
  let env = flattenArray(groups.map(group => group.envVars));
  return env
    .filter(env => env.value != null)
    // TODO: we need proper escape for shell vars here
    // $FlowFixMe: make sure env.value is refined above
    .map(env => `\texport ${env.name}="${env.value}";`)
    .join('\\\n');
}

function escapeEnvVar(command) {
  return command.replace(/\$([^\(])/g, '$$$$$1');
}

function escapeName(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_');
}

function flattenArray<T>(arrayOfArrays: Array<Array<T>>): Array<T> {
  return [].concat(...arrayOfArrays);
}

module.exports = {
  renderMakefile,
  renderEnv,
};
