/**
 * Utilities for programmatic Makefile genetation.
 *
 * @flow
 */

import type {EnvironmentVar} from './PackageEnvironment';

export type MakeRule = {
  type: 'rule';
  name?: ?string;
  target: string;
  env?: Array<EnvironmentVar>;
  command?: ?string;
  dependencies?: Array<string>;
  exportEnv?: Array<string>;
};

export type MakeDefine = {
  type: 'define';
  name: string;
  value: string;
};

export type MakeRawItem = {|
  type: 'raw';
  value: string;
|};

export type MakeItem =
  | MakeRule
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
      } else {
        throw new Error('Unknown make item:' + JSON.stringify(item));
      }
    })
    .join('\n\n');
}

function renderMakeDefine({name, value}) {
  return `define ${name}\n${value}\nendef`;
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
    name
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
    if (name != null) {
      return `${prelude}${header}\n\t@echo '${name}'\n${recipe}`;
    } else {
      return `${prelude}${header}\n${recipe}`;
    }
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

function renderEnvImpl(env: Array<EnvironmentVar>): string {
  return env
    .filter(env => env.value != null)
    // TODO: we need proper escape for shell vars here
    // $FlowFixMe: make sure env.value is refined above
    .map(env => `\texport ${env.name}="${env.value}";`)
    .join('\\\n');
}

function renderEnv(env: Array<EnvironmentVar>): string {
  return escapeEnvVar(renderEnvImpl(env));
}

function escapeEnvVar(command) {
  return command.replace(/\$([^\(])/g, '$$$$$1');
}

module.exports = {
  renderMakefile,
  renderEnv,
};
