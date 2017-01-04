const {exec: execBase, readFile} = require('../harness');

function exec(cmd) {
  return execBase(cmd, {cwd: __dirname});
}

function execWithFailure(cmd) {
  return execBase(cmd, {cwd: __dirname, expectFailure: true});
}

test('env', () => {
  let res = exec('../../.bin/esy');
  expect(res.status).toBe(0);
  expect(res.stdout.toString()).toMatchSnapshot();
});

test('catches violation', () => {
  let res = execWithFailure(`
  rm -rf _build _install _esy_store
  ../../.bin/esy build`
  );
  expect(res.status).not.toBe(0);
  expect(readFile(__dirname, 'should_be_GOOD')).toBe('GOOD');
});
