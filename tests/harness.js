const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

function exec(cmd, options) {
  let proc = spawnSync(`
  set -euo pipefail
  export ESY__STORE="${options.cwd}/_esy_store"
  ${cmd}
  `, Object.assign({}, {shell: '/bin/bash'}, options));
  if (!options.expectFailure && proc.status != 0) {
    console.log('Error while executing, see stdout:\n', proc.stdout.toString());
    console.log('Error while executing, see stderr:\n', proc.stderr.toString());
  }
  return proc;
}

function readFile(...filename) {
  filename = path.join(...filename);
  return fs.readFileSync(filename, 'utf8').trim();
}

module.exports = {exec, readFile};
