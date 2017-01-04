const {exec: execBase, readFile} = require('../harness');

function exec(cmd) {
  return execBase(cmd, {cwd: __dirname});
}

test('env', () => {
  let res = exec('../../.bin/esy');
  expect(res.status).toBe(0);
  expect(res.stdout.toString()).toMatchSnapshot();
});

test('forces build to happen in $cur__target_dir', () => {
  let res = exec(`
  rm -rf _build _install _esy_store
  ../../.bin/esy build
  `);
  expect(res.status).toBe(0);
  expect(readFile(__dirname, 'OK')).toBe('OK');
  expect(readFile(__dirname, '_build', 'OK')).toBe('OK!!!');
});
