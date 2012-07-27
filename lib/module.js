// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var NativeModule = require('native_module');
var Script = process.binding('evals').NodeScript;
var runInThisContext = Script.runInThisContext;
var runInNewContext = Script.runInNewContext;
var assert = require('assert').ok;


// If obj.hasOwnProperty has been overridden, then calling
// obj.hasOwnProperty(prop) will break.
// See: https://github.com/joyent/node/issues/1707
function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}


function Module(id, parent) {
  this.id = id;
  this.exports = {};
  this.parent = parent;
  if (parent && parent.children) {
    parent.children.push(this);
  }

  this.filename = null;
  this.loaded = false;
  this.children = [];
  this.defineCache = {};
  this.loaderCache = {};
}
module.exports = Module;

// Set the environ variable NODE_MODULE_CONTEXTS=1 to make node load all
// modules in thier own context.
Module._contextLoad = (+process.env['NODE_MODULE_CONTEXTS'] > 0);
Module._cache = {};
Module._pathCache = {};
Module._extensions = {};
var modulePaths = [];
Module.globalPaths = [];

Module.wrapper = NativeModule.wrapper;
Module.wrap = NativeModule.wrap;

var path = NativeModule.require('path');

Module._debug = function() {};
if (process.env.NODE_DEBUG && /module/.test(process.env.NODE_DEBUG)) {
  Module._debug = function(x) {
    console.error(x);
  };
}


// We use this alias for the preprocessor that filters it out
var debug = Module._debug;


// given a module name, and a list of paths to test, returns the first
// matching file in the following precedence.
//
// require("a.<ext>")
//   -> a.<ext>
//
// require("a")
//   -> a
//   -> a.<ext>
//   -> a/index.<ext>

function statPath(path) {
  var fs = NativeModule.require('fs');
  try {
    return fs.statSync(path);
  } catch (ex) {}
  return false;
}

// check if the directory is a package.json dir
var packageCache = {};

function readPackage(requestPath) {
  if (hasOwnProperty(packageCache, requestPath)) {
    return packageCache[requestPath];
  }

  var fs = NativeModule.require('fs');
  try {
    var jsonPath = path.resolve(requestPath, 'package.json');
    var json = fs.readFileSync(jsonPath, 'utf8');
  } catch (e) {
    return false;
  }

  try {
    var pkg = packageCache[requestPath] = JSON.parse(json);
  } catch (e) {
    e.path = jsonPath;
    e.message = 'Error parsing ' + jsonPath + ': ' + e.message;
    throw e;
  }
  return pkg;
}

function tryPackage(requestPath, exts) {
  var pkg = readPackage(requestPath);

  if (!pkg || !pkg.main) return false;

  var filename = path.resolve(requestPath, pkg.main);
  return tryFile(filename) || tryExtensions(filename, exts) ||
         tryExtensions(path.resolve(filename, 'index'), exts);
}

// In order to minimize unnecessary lstat() calls,
// this cache is a list of known-real paths.
// Set to an empty object to reset.
Module._realpathCache = {};

// check if the file exists and is not a directory
function tryFile(requestPath) {
  var fs = NativeModule.require('fs');
  var stats = statPath(requestPath);
  if (stats && !stats.isDirectory()) {
    return fs.realpathSync(requestPath, Module._realpathCache);
  }
  return false;
}

// given a path check a the file exists with any of the set extensions
function tryExtensions(p, exts) {
  for (var i = 0, EL = exts.length; i < EL; i++) {
    var filename = tryFile(p + exts[i]);

    if (filename) {
      return filename;
    }
  }
  return false;
}

// Trims the . and .. from an array of path segments.
// It will keep a leading path segment if a .. will become
// the first path segment, to help with module name lookups,
// which act like paths, but can be remapped. But the end result,
// all paths that use this function should look normalized.
// NOTE: this method MODIFIES the input array.
function trimDots(ary) {
  var i, part;
  for (i = 0; i < ary.length; i += 1) {
    part = ary[i];
    if (part === '.') {
      ary.splice(i, 1);
      i -= 1;
    } else if (part === '..') {
      if (i === 1 && (ary[2] === '..' || ary[0] === '..')) {
        //End of the line. Keep at least one non-dot
        //path segment at the front so it can be mapped
        //correctly to disk. Otherwise, there is likely
        //no path mapping for a path starting with '..'.
        //This can still fail, but catches the most reasonable
        //uses of ..
        break;
      } else if (i > 0) {
        ary.splice(i - 1, 2);
        i -= 2;
      }
    }
  }
}

// Create the normalize() function passed to a loader plugin's
// normalize method.
function makeNormalize(relName) {
  return function(name) {
    return normalize(name, relName);
  };
}

function normalize(name, baseName) {
  var baseParts;

  //Adjust any relative paths.
  if (name && name.charAt(0) === '.') {
    //If have a base name, try to normalize against it,
    //otherwise, assume it is a top-level require that will
    //be relative to baseUrl in the end.
    if (baseName) {
      baseParts = baseName.split('/');
      baseParts = baseParts.slice(0, baseParts.length - 1);
      baseParts = baseParts.concat(name.split('/'));
      trimDots(baseParts);
      name = baseParts.join('/');
    }
  }

  return name;
}

Module._findPath = function(request, paths) {
  var exts = Object.keys(Module._extensions);

  if (request.charAt(0) === '/') {
    paths = [''];
  }

  var trailingSlash = (request.slice(-1) === '/');

  var cacheKey = JSON.stringify({request: request, paths: paths});
  if (Module._pathCache[cacheKey]) {
    return Module._pathCache[cacheKey];
  }

  // For each path
  for (var i = 0, PL = paths.length; i < PL; i++) {
    var basePath = path.resolve(paths[i], request);
    var filename;

    if (!trailingSlash) {
      // try to join the request to the path
      filename = tryFile(basePath);

      if (!filename && !trailingSlash) {
        // try it with each of the extensions
        filename = tryExtensions(basePath, exts);
      }
    }

    if (!filename) {
      filename = tryPackage(basePath, exts);
    }

    if (!filename) {
      // try it with each of the extensions at "index"
      filename = tryExtensions(path.resolve(basePath, 'index'), exts);
    }

    if (filename) {
      Module._pathCache[cacheKey] = filename;
      return filename;
    }
  }
  return false;
};

// 'from' is the __dirname of the module.
Module._nodeModulePaths = function(from) {
  // guarantee that 'from' is absolute.
  from = path.resolve(from);

  // note: this approach *only* works when the path is guaranteed
  // to be absolute.  Doing a fully-edge-case-correct path.split
  // that works on both Windows and Posix is non-trivial.
  var splitRe = process.platform === 'win32' ? /[\/\\]/ : /\//;
  // yes, '/' works on both, but let's be a little canonical.
  var joiner = process.platform === 'win32' ? '\\' : '/';
  var paths = [];
  var parts = from.split(splitRe);

  for (var tip = parts.length - 1; tip >= 0; tip--) {
    // don't search in .../node_modules/node_modules
    if (parts[tip] === 'node_modules') continue;
    var dir = parts.slice(0, tip + 1).concat('node_modules').join(joiner);
    paths.push(dir);
  }

  return paths;
};


Module._resolveLookupPaths = function(request, parent) {
  if (NativeModule.exists(request)) {
    return [request, []];
  }

  var start = request.substring(0, 2);
  if (start !== './' && start !== '..') {
    var paths = modulePaths;
    if (parent) {
      if (!parent.paths) parent.paths = [];
      paths = parent.paths.concat(paths);
    }
    return [request, paths];
  }

  // with --eval, parent.id is not set and parent.filename is null
  if (!parent || !parent.id || !parent.filename) {
    // make require('./path/to/foo') work - normally the path is taken
    // from realpath(__filename) but with eval there is no filename
    var mainPaths = ['.'].concat(modulePaths);
    mainPaths = Module._nodeModulePaths('.').concat(mainPaths);
    return [request, mainPaths];
  }

  // Is the parent an index module?
  // We can assume the parent has a valid extension,
  // as it already has been accepted as a module.
  var isIndex = /^index\.\w+?$/.test(path.basename(parent.filename));
  var parentIdPath = isIndex ? parent.id : path.dirname(parent.id);
  var id = path.resolve(parentIdPath, request);

  // make sure require('./path') and require('path') get distinct ids, even
  // when called from the toplevel js file
  if (parentIdPath === '.' && id.indexOf('/') === -1) {
    id = './' + id;
  }

  debug('RELATIVE: requested:' + request +
        ' set ID to: ' + id + ' from ' + parent.id);

  return [id, [path.dirname(parent.filename)]];
};


Module._load = function(request, parent, isMain) {
  if (parent) {
    debug('Module._load REQUEST  ' + (request) + ' parent: ' + parent.id);
  }

  var filename = Module._resolveFilename(request, parent);

  var cachedModule = Module._cache[filename];
  if (cachedModule) {
    return cachedModule.exports;
  }

  if (NativeModule.exists(filename)) {
    // REPL is a special case, because it needs the real require.
    if (filename == 'repl') {
      var replModule = new Module('repl');
      replModule._compile(NativeModule.getSource('repl'), 'repl.js');
      NativeModule._cache.repl = replModule;
      return replModule.exports;
    }

    debug('load native module ' + request);
    return NativeModule.require(filename);
  }

  var module = new Module(filename, parent);

  if (isMain) {
    process.mainModule = module;
    module.id = '.';
  }

  Module._cache[filename] = module;

  var hadException = true;

  try {
    module.load(filename);
    hadException = false;
  } finally {
    if (hadException) {
      delete Module._cache[filename];
    }
  }

  return module.exports;
};

Module._resolveFilename = function(request, parent) {
  if (NativeModule.exists(request)) {
    return request;
  }

  var resolvedModule = Module._resolveLookupPaths(request, parent);
  var id = resolvedModule[0];
  var paths = resolvedModule[1];

  // look up the filename first, since that's the cache key.
  debug('looking for ' + JSON.stringify(id) +
        ' in ' + JSON.stringify(paths));

  var filename = Module._findPath(request, paths);
  if (!filename) {
    var err = new Error("Cannot find module '" + request + "'");
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return filename;
};

Module.prototype.load = function(filename) {
  debug('load ' + JSON.stringify(filename) +
        ' for module ' + JSON.stringify(this.id));

  assert(!this.loaded);
  this.filename = filename;
  this.paths = Module._nodeModulePaths(path.dirname(filename));

  var extension = path.extname(filename) || '.js';
  if (!Module._extensions[extension]) extension = '.js';
  Module._extensions[extension](this, filename);
  this.loaded = true;
};


Module.prototype.require = function(path) {
  return Module._load(path, this);
};


Module.prototype.makePluginLoad = function(pluginId, id) {
  var self = this;
  var fullId = pluginId + '!' + id;

  function load(value) {
    if (Module._cache.hasOwnProperty(fullId)) {
      throw new Error(fullId + ' has already been set.');
    }

    Module._cache[fullId] = {
      exports: value
    };
  }

  load.fromText = function(id, text) {
    var filename = Module._resolveFilename(id, self);
    self._compile(stripBOM(text), filename);
  };

  return load;
};


Module.prototype.makeRequire = function(module, relId, options) {
  var self = this;

  options = options || {};

  function require(path, callback) {
    if (typeof path === 'string') {
      if (callback) {
        throw new Error('require() for a single module ' +
                        path + ' only accepts one argument');
      }

      var index = path.indexOf('!'),
          id = path,
          originalId = id;

      if (index === -1) {
        id = normalize(id, relId);

        //Straight module lookup. If it is one of the special dependencies,
        //deal with it, otherwise, delegate to node.
        if (id === 'require') {
          return require;
        } else if (id === 'exports') {
          return module.exports;
        } else if (id === 'module') {
          //Only return module if inside a define() derivative.
          return options.useNativeModule ? self.require('module') : module;
        } else if (self.loaderCache.hasOwnProperty(id)) {
          return self.loaderCache[id];
        } else if (self.defineCache[id]) {
          self.runFactory.apply(self, defineCache[id]);
          return self.loaderCache[id];
        } else {
          return self.require(originalId);
        }
      } else {
        //There is a plugin in play.
        var prefix = normalize(id.substring(0, index), relId);
        id = id.substring(index + 1, id.length);

        var plugin = require(prefix);

        if (plugin.normalize) {
          id = plugin.normalize(id, makeNormalize(relId));
        } else {
          //Normalize the ID normally.
          id = normalize(id, relId);
        }

        var fullId = prefix + '!' + id;

        if (self.loaderCache.hasOwnProperty(fullId)) {
          return self.loaderCache[fullId];
        } else if (Module._cache.hasOwnProperty(fullId)) {
          return Module._cache[fullId].exports;
        } else {
          plugin.load(id, self.makeRequire(module, relId, {
            syncCallback: true
          }), self.makePluginLoad(prefix, id), {});

          // Require plugins synchronously return a value.
          if (!Module._cache.hasOwnProperty(fullId)) {
            throw new Error('Loader plugin' + prefix + ' needs to ' +
                            'synchronously call the load callback for ' +
                            id + ' when running in node.');
          }
          return Module._cache[fullId].exports;
        }
      }
    } else {
      // Array of dependencies with a callback.
      // Wait for next tick to call back the require call,
      // unless the options.syncCallback is true, which
      // is the case for loader plugins.
      var callbackRequire = function() {
        // Convert the dependencies to modules.
        var deps = path.map(function(depName) {
          return require(depName);
        });
        callback.apply(null, deps);
      };

      if (options.syncCallback) {
        callbackRequire();
      } else {
        process.nextTick(callbackRequire);
      }
    }
  }

  require.toUrl = function(filePath) {
    return path.resolve(path.dirname(module.filename), filePath);
  };

  require.resolve = function(request) {
    return Module._resolveFilename(request, self);
  };

  Object.defineProperty(require, 'paths', { get: function() {
    throw new Error('require.paths is removed. Use ' +
                    'node_modules folders, or the NODE_PATH ' +
                    'environment variable instead.');
  }});

  require.main = process.mainModule;

  // Enable support to add extra extension types
  require.extensions = Module._extensions;
  require.registerExtension = function() {
    throw new Error('require.registerExtension() removed. Use ' +
                    'require.extensions instead.');
  };

  require.cache = Module._cache;

  return require;
};

Module.prototype.runFactory = function(id, deps, factory) {
  var r, m, result;

  if (id) {
    // A named module, so only local to the current module.
    m = {
      id: id,
      filename: this.filename,
      exports: (this.loaderCache[id] = {})
    };
    r = this.makeRequire(m, id);
  } else {
    // The module definition for the current module.
    // Only support one define call per file
    if (this.defineAlreadyCalled) {
      throw new Error('define() with no module ID cannot be called ' +
                      'more than once per file.');
    }
    this.defineAlreadyCalled = true;

    // Use the real variables from node
    // Use module.exports for exports, since
    // the exports in here is amdefine exports.
    m = this;
    r = this.makeRequire(m, m.id);
  }

  // If there are dependencies, they are strings, so need
  // to convert them to dependency values.
  if (deps) {
    deps = deps.map(function(depName) {
      return r(depName);
    });
  }

  // Call the factory with the right dependencies.
  if (typeof factory === 'function') {
    result = factory.apply(module.exports, deps);
  } else {
    result = factory;
  }

  if (result !== undefined) {
    m.exports = result;
    if (id) {
      this.loaderCache[id] = m.exports;
    }
  }
};


// Resolved path to process.argv[1] will be lazily placed here
// (needed for setting breakpoint when called with --debug-brk)
var resolvedArgv;


// Returns exception if any
Module.prototype._compile = function(content, filename) {
  var self = this;
  var require = self.makeRequire(self, filename, {
    useNativeModule: true
  });

  // remove shebang
  content = content.replace(/^\#\!.*/, '');

  function define(id, deps, factory) {
    if (Array.isArray(id)) {
      factory = deps;
      deps = id;
      id = undefined;
    } else if (typeof id !== 'string') {
      factory = id;
      id = deps = undefined;
    }

    if (deps && !Array.isArray(deps)) {
      factory = deps;
      deps = undefined;
    }

    if (!deps) {
      deps = ['require', 'exports', 'module'];
    }

    // Set up properties for this module. If an ID, then use
    // internal cache. If no ID, then use the external variables
    // for this node module.
    if (id) {
      // Put the module in deep freeze until there is a
      // require call for it.
      self.defineCache[id] = [id, deps, factory];
    } else {
      self.runFactory(id, deps, factory);
    }
  }

  // Indicate this define() conforms to AMD's define,
  // library scripts will test for this property before
  // calling define().
  define.amd = {};

  var dirname = path.dirname(filename);

  if (Module._contextLoad) {
    if (self.id !== '.') {
      debug('load submodule');
      // not root module
      var sandbox = {};
      for (var k in global) {
        sandbox[k] = global[k];
      }
      sandbox.require = require;
      sandbox.define = define;
      sandbox.exports = self.exports;
      sandbox.__filename = filename;
      sandbox.__dirname = dirname;
      sandbox.module = self;
      sandbox.global = sandbox;
      sandbox.root = root;

      return runInNewContext(content, sandbox, filename, true);
    }

    debug('load root module');
    // root module
    global.require = require;
    global.define = define;
    global.exports = self.exports;
    global.__filename = filename;
    global.__dirname = dirname;
    global.module = self;

    return runInThisContext(content, filename, true);
  }

  // create wrapper function
  var wrapper = Module.wrap(content);

  var compiledWrapper = runInThisContext(wrapper, filename, true);
  if (global.v8debug) {
    if (!resolvedArgv) {
      resolvedArgv = Module._resolveFilename(process.argv[1], null);
    }

    // Set breakpoint on module start
    if (filename === resolvedArgv) {
      global.v8debug.Debug.setBreakPoint(compiledWrapper, 0, 0);
    }
  }
  var args = [self.exports, require, self, filename, dirname, define];
  return compiledWrapper.apply(self.exports, args);
};


function stripBOM(content) {
  // Remove byte order marker. This catches EF BB BF (the UTF-8 BOM)
  // because the buffer-to-string conversion in `fs.readFileSync()`
  // translates it to FEFF, the UTF-16 BOM.
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }
  return content;
}


// Native extension for .js
Module._extensions['.js'] = function(module, filename) {
  var content = NativeModule.require('fs').readFileSync(filename, 'utf8');
  module._compile(stripBOM(content), filename);
};


// Native extension for .json
Module._extensions['.json'] = function(module, filename) {
  var content = NativeModule.require('fs').readFileSync(filename, 'utf8');
  try {
    module.exports = JSON.parse(stripBOM(content));
  } catch (err) {
    err.message = filename + ': ' + err.message;
    throw err;
  }
};


//Native extension for .node
Module._extensions['.node'] = function(module, filename) {
  process.dlopen(filename, module.exports);
};


// bootstrap main module.
Module.runMain = function() {
  // Load the main module--the command line argument.
  Module._load(process.argv[1], null, true);
};

Module._initPaths = function() {
  var paths = [path.resolve(process.execPath, '..', '..', 'lib', 'node')];

  if (process.env['HOME']) {
    paths.unshift(path.resolve(process.env['HOME'], '.node_libraries'));
    paths.unshift(path.resolve(process.env['HOME'], '.node_modules'));
  }

  if (process.env['NODE_PATH']) {
    var splitter = process.platform === 'win32' ? ';' : ':';
    paths = process.env['NODE_PATH'].split(splitter).concat(paths);
  }

  modulePaths = paths;

  // clone as a read-only copy, for introspection.
  Module.globalPaths = modulePaths.slice(0);
};

// bootstrap repl
Module.requireRepl = function() {
  return Module._load('repl', '.');
};

Module._initPaths();

// backwards compatibility
Module.Module = Module;
