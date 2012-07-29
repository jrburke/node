var counter = 1;

define('dormant', function (require) {
  // This module should never be required, so counter
  // should stay at 1.
  counter += 1;

  return {
    name: 'dormant'
  };
})

define('local', function (require, exports, module) {
debugger;
  module.exports = {
    name: 'local',
    hasPathJoin: !!require('path').join
  };
});

define(function (require) {
  return {
    name: 'mixed',
    separate: require('./sub/separate'),
    local: require('local'),
    counter: counter
  }
});