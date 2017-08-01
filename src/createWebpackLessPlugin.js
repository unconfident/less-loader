const path = require('path');
const less = require('less');
const loaderUtils = require('loader-utils');
const pify = require('pify');

const stringifyLoader = require.resolve('./stringifyLoader.js');
const trailingSlash = /[/\\]$/;
const isLessCompatible = /^[^!]+\.(le|c)ss$/;
// Less automatically adds a .less file extension if no extension was given.
// This is problematic if there is a module request like @import "~some-module";
// because in this case Less will call our file manager with `~some-module.less`.
// Since dots in module names are highly discouraged, we can safely assume that
// this is an error and we need to remove the .less extension again.
// However, we must not match something like @import "~some-module/file.less";
const matchMalformedModuleFilename = /^(~[^/\\]+)\.less$/;

/**
 * Creates a Less plugin that uses webpack's resolving engine that is provided by the loaderContext.
 *
 * @param {LoaderContext} loaderContext
 * @param {string=} root
 * @returns {LessPlugin}
 */
function createWebpackLessPlugin(loaderContext) {
  const { fs } = loaderContext;
  const resolve = pify(loaderContext.resolve.bind(loaderContext));
  const loadModule = pify(loaderContext.loadModule.bind(loaderContext));
  const readFile = pify(fs.readFile.bind(fs));

  function resolveImportString(currentDirectory, request) {
    // Gives us absolute path in error message in case of an error. Works just fine without it.
    const resolvedContext = path.resolve(loaderContext.context, currentDirectory);

    return Promise.all(request.split('!').map((subrequest) => {
      if (['', '-'].indexOf(subrequest) !== -1) {
        return subrequest;
      }

      const splitByQuestionMark = subrequest.split('?');

      // TODO: research how webpack resolves loaders in a complex require string.
      // Maybe loaderContext._compiler.resolvers.loader should be used for everything but the last segment instead

      return resolve(resolvedContext, splitByQuestionMark.shift()).then((filePathSegment) => {
        splitByQuestionMark.unshift(filePathSegment);
        return splitByQuestionMark.join('?');
      });
    })).then(segments => segments.join('!'));
  }

  function loadModuleAsString(moduleRequest) {
    // TODO: still doesn't work with special prefixes (no pre/post loaders, no autloaders etc)
    // NOTE: Perhaps I should access webpack's NormalModuleFactory instead of this manual handling of all that.
    const requestString = moduleRequest.replace(/^(!!|-!|)/, `$1${stringifyLoader}!`);
    return loadModule(requestString).then(JSON.parse);
  }

  class WebpackFileManager extends less.FileManager {
    supports(/* filename, currentDirectory, options, environment */) { // eslint-disable-line class-methods-use-this
      // Our WebpackFileManager handles all the files
      return true;
    }

    loadFile(filename, currentDirectory /* , options, environment */) { // eslint-disable-line class-methods-use-this
      const url = filename.replace(matchMalformedModuleFilename, '$1');
      const moduleRequest = loaderUtils.urlToRequest(url, url.charAt(0) === '/' ? '' : null);
      // Less is giving us trailing slashes, but the context should have no trailing slash
      const context = currentDirectory.replace(trailingSlash, '');

      return resolveImportString(context, moduleRequest).then((resolvedRequest) => {
        const shouldLoadAsIs = isLessCompatible.test(moduleRequest);
        const filePath = resolvedRequest.split('!').pop().split('?').shift();

        loaderContext.addDependency(filePath);

        return Promise.resolve()
          .then(() => {
            if (shouldLoadAsIs) return readFile(filePath).then(data => data.toString('utf8'));
            return loadModuleAsString(resolvedRequest);
          })
          .then((contents) => {
            return {
              contents,
              filename: filePath,
            };
          });
      });
    }
  }

  return {
    install(lessInstance, pluginManager) {
      pluginManager.addFileManager(new WebpackFileManager());
    },
    minVersion: [2, 1, 1],
  };
}

module.exports = createWebpackLessPlugin;
