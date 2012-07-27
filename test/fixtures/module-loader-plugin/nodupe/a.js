var x = require('./proxy!./x');
x.modifiedByA = true;

var b = require('./sub/b');

module.exports = {
  name: 'a',
  x: x,
  b: b
};
