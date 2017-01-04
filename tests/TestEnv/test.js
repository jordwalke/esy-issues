const {exec: execBase} = require('../harness');

function exec(cmd) {
  return execBase(cmd, {cwd: __dirname});
}

exec(`
pushd PackageC
popd

pushd PackageB
rm -rf node_modules
mkdir node_modules
cd node_modules
ln -s ../../PackageC ./PackageC
popd

pushd PackageA
rm -rf node_modules
mkdir node_modules
cd node_modules
ln -s ../../PackageC ./PackageC
ln -s ../../PackageB ./PackageB
popd
`);

test('environment for PackageC', () => {
  let res = exec(`
  cd PackageC
  ../../../.bin/esy
  `);
  expect(res.status).toBe(0);
  expect(res.stdout.toString()).toMatchSnapshot();
});

test('environment for PackageB', () => {
  let res = exec(`
  cd PackageB
  ../../../.bin/esy
  `);
  expect(res.status).toBe(0);
  expect(res.stdout.toString()).toMatchSnapshot();
});

test('environment for PackageA', () => {
  let res = exec(`
  cd PackageA
  ../../../.bin/esy
  `);
  expect(res.status).toBe(0);
  expect(res.stdout.toString()).toMatchSnapshot();
});
