import path from 'path';
import findUp from 'find-up';
import _ from 'lodash';
import resolve from 'resolve';
import Constants from '../constants';
import log from '../log';
import schema from './config-schema';
import less from '../assets/less';
import sass from '../assets/sass';
import browserify from '../assets/browserify';

const assetProcessors = {
  browserify,
  less,
  sass,
};

function requireLocalModule(moduleName, { basedir } = {}) {
  const modulePath = resolve.sync(moduleName, { basedir });
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(modulePath);
}

/**
 * Look for a {@link Constants.ConfigFilename} file in this directory or any
 * parent directories.
 * @return {string} Path to the local {@link Constants.ConfigFilename} file.
 */
function findLocal() {
  // Look up directories to find our file.
  const configYmlPath = findUp.sync(Constants.ConfigFilename);

  // If we still can't find our file then throw an error.
  if (!configYmlPath) {
    throw new Error(`No '${Constants.ConfigFilename}' file found.`);
  }

  return configYmlPath;
}

/**
 * Find the directory where our local {@link Constants.ConfigFilename} exists.
 * @return {string} Path to the directory where our
 *   {@link Constants.ConfigFilename} file exists.
 */
function findLocalDir() {
  return findLocal().replace(Constants.ConfigFilename, '');
}

/**
 * Loads the local {@link Constants.ConfigFilename} file.
 * @param {string} root Root path of instance.
 * @return {Object} Config file.
 */
function loadConfigFile(root) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(root, Constants.ConfigFilename));
}

/**
 * This coerces a string or RegExp to a function that can be used as a matching
 * function.
 * @param {string|RegExp|function} value Input value.
 * @return {function}
 */
function valueToFunction(value) {
  let functionValue = value;

  if (_.isString(functionValue)) {
    // A string value must match from the beginning of the input value.
    functionValue = new RegExp(`^${functionValue}`);
  }

  if (!_.isFunction(functionValue)) {
    const regExp = functionValue;
    functionValue = filePath => filePath.match(regExp) !== null;
  }

  return functionValue;
}

export default class Config {
  constructor(root = findLocalDir()) {
    /**
     * Full path to where we're running our app from.
     * @type {string} Full path.
     */
    this.root = root;

    /**
     * Raw object that holds the config object.
     * @type {Object}
     * @private
     */
    this._raw = Object.create(null);
  }

  /**
   * Update our in-memory representation of the config file from disk.
   * This load's the YAML file, parses it, validates it, sets defaults,
   * and then updates our internal instance.
   */
  update() {
    // Load Constants.ConfigFilename.
    const loadedConfig = loadConfigFile(this.root);
    const config = _.isFunction(loadedConfig) ? loadedConfig() : loadedConfig;

    // Validate config against schema. Sets defaults where neccessary.
    const { error, value } = schema.validate(config);

    if (error != null) {
      log.error(error.annotate());
      throw new Error(`${Constants.ConfigFilename} validation error: ` +
        `${error.message}`);
    }

    // Store config data privately. Assign all default values.
    this._raw = _.defaultsDeep(
      value,
      schema.validate().value
    );

    // Calculate absolute path of 'paths' keys.
    this._raw.path[Constants.SourceKey] = path.resolve(
      this.root, this._raw.path[Constants.SourceKey]
    );
    _.each(this._raw.path, (val, key) => {
      if (key !== Constants.SourceKey) {
        this._raw.path[key] = path.resolve(
          this._raw.path.source,
          this._raw.path[key]
        );
      }
    });

    // Sort our default values. They are sorted by:
    //   1. Scopes with only metadata are first.
    //   2. Scopes with paths are sorted from shortest to longest (most
    //      specific).
    //   3. Scopes with both metadata and paths are sorted after.
    //   4. If two objects have the same scope, or if they both have metadata,
    //      then we sort those values in the order in which they were given.
    const sortedDefaults = _.sortBy(this._raw.file.defaults, [
      defaultObj => _.get(defaultObj, 'scope.path', '').length,
      defaultObj => defaultObj.scope.metadata != null,
    ]);

    // Update each scope path to be absolute relative to source path.
    this._raw.file.defaults = sortedDefaults.map((defaultObj) => {
      if (defaultObj.scope.path != null) {
        defaultObj.scope.path = path.resolve(
          this._raw.path.source,
          defaultObj.scope.path
        );
      }
      return defaultObj;
    });

    // For a given value if it is a string resolve it as if it's an NPM module.
    const resolveMiddlewareModules = (moduleVal) => {
      if (_.isString(moduleVal)) {
        return requireLocalModule(moduleVal, { basedir: this.root });
      }
      return moduleVal;
    };

    // Ensure all ignore values are functions.
    this._raw.ignore = this._raw.ignore.map(valueToFunction);

    // Make sure all values are arrays.
    const middlewares = _.flatten(Array.of(this._raw.middlewares));
    this._raw.middlewares = middlewares.map(resolveMiddlewareModules);

    _.forEach(this._raw.lifecycle, (val, key) => {
      const newVal = _.flatten(Array.of(val));
      this._raw.lifecycle[key] = newVal.map(resolveMiddlewareModules);
    });

    // Convert every config.asset.test value to be a function.
    this._raw.assets = this._raw.assets.map((asset) => {
      let useVal = asset.use;
      if (_.isString(useVal)) {
        useVal = assetProcessors[useVal] ?
          assetProcessors[useVal] :
          requireLocalModule(useVal, { basedir: this.root });
      }

      return {
        test: valueToFunction(asset.test),
        use: useVal,
      };
    });
  }

  /**
   * Getter to access config properties. Everything is pushed through here
   * so we can provide required defaults if they're not set. Also enforces
   * uniform access to config properties.
   * @param {[string]} objectPath Path to object property, i.e. 'path.source'.
   *   If it isn't given then you get the entire config object.
   * @return {*} Config value.
   */
  get(objectPath) {
    if (objectPath === undefined) {
      return this._raw;
    }

    const value = _.get(this._raw, objectPath);

    if (value == null) {
      throw new Error(`Tried to access config path "${objectPath}" ` +
        'that does not exist.');
    }

    return value;
  }
}
