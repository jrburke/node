define(function (require) {
  return {
    doCallback: function (cb) {
      require(['./e'], cb);
    }
  }
});
