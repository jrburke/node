define(function (require, exports) {
  exports.name = 'b';
  exports.c = require('./c');

  // Test that b and c get the same
  // object for d. In the asserts,
  // the "modifiedByB" property should
  // be visible on both b and c's d reference.
  var d = require('./d');
  d.modifiedByB = true;
  exports.d = d;
});
