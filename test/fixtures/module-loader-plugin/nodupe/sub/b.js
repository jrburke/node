define(function (require, exports, module) {
  var x = require('../proxy!../x');
  x.modifiedByB = true;

  module.exports = {
    name: 'b',
    x: x
  };
});
