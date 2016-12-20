/**
 * @flow
 */

function mapObject<S: *, F: <V>(v: V) => *>(obj: S, f: F): $ObjMap<S, F> {
  let nextObj = {};
  for (var k in obj) {
    nextObj[k] = f(obj[k], k);
  }
  return nextObj;
}

module.exports = {
  mapObject
};
