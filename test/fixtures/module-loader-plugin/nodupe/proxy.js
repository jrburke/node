exports.load = function (id, require, load, config) {
  require([id], load);
};
