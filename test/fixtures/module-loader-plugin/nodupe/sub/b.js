define(function (require, exports, module) {
  debugger;
  var x = require('../proxy!../x');
  x.modifiedByB = true;

  module.exports = {
    name: 'b',
    x: x
  };
});
