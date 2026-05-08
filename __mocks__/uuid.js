const crypto = require('crypto');

function randomBytes16() {
  return crypto.randomBytes(16);
}

function bytesToUuid(b) {
  const hex = b.toString('hex');
  return (
    hex.substring(0, 8) +
    '-' +
    hex.substring(8, 12) +
    '-' +
    hex.substring(12, 16) +
    '-' +
    hex.substring(16, 20) +
    '-' +
    hex.substring(20, 32)
  );
}

function v4() {
  const b = randomBytes16();
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return bytesToUuid(b);
}

function v7() {
  return v4();
}

function v1() {
  return v4();
}

function v3() {
  return v4();
}

function v5() {
  return v4();
}

function validate() {
  return true;
}

function parse(s) {
  return Buffer.from(s.replace(/-/g, ''), 'hex');
}

function stringify(arr) {
  return bytesToUuid(Buffer.from(arr));
}

module.exports = {
  v1,
  v3,
  v4,
  v5,
  v7,
  validate,
  parse,
  stringify,
  NIL: '00000000-0000-0000-0000-000000000000',
  MAX: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  default: { v1, v3, v4, v5, v7 },
};
