"use strict";

var _path = require("../utils/path");

const _ = require(`lodash`);

const fs = require(`fs-extra`);

const crypto = require(`crypto`);

const {
  store,
  emitter
} = require(`../redux/`);

let lastHash = null;

const resetLastHash = () => {
  lastHash = null;
};

const pickComponentFields = page => _.pick(page, [`component`, `componentChunkName`]);

const getComponents = pages => _(pages).map(pickComponentFields).uniqBy(c => c.componentChunkName).value();

const pickMatchPathFields = page => _.pick(page, [`path`, `matchPath`]);

const getMatchPaths = pages => pages.filter(page => page.matchPath).map(pickMatchPathFields);

const createHash = (matchPaths, components) => crypto.createHash(`md5`).update(JSON.stringify({
  matchPaths,
  components
})).digest(`hex`); // Write out pages information.


const writeAll = async state => {
  const {
    program
  } = state;
  const pages = [...state.pages.values()];
  const matchPaths = getMatchPaths(pages);
  const components = getComponents(pages);
  const newHash = createHash(matchPaths, components);

  if (newHash === lastHash) {
    // Nothing changed. No need to rewrite files
    return Promise.resolve();
  }

  lastHash = newHash; // Create file with sync requires of components/json files.

  let syncRequires = `const { hot } = require("react-hot-loader/root")

// prefer default export if available
const preferDefault = m => m && m.default || m
\n\n`;
  syncRequires += `exports.components = {\n${components.map(c => `  "${c.componentChunkName}": hot(preferDefault(require("${(0, _path.joinPath)(c.component)}")))`).join(`,\n`)}
}\n\n`; // Create file with async requires of components/json files.

  let asyncRequires = `// prefer default export if available
const preferDefault = m => m && m.default || m
\n`;
  asyncRequires += `exports.components = {\n${components.map(c => `  "${c.componentChunkName}": () => import("${(0, _path.joinPath)(c.component)}" /* webpackChunkName: "${c.componentChunkName}" */)`).join(`,\n`)}
}\n\n`;

  const writeAndMove = (file, data) => {
    const destination = (0, _path.joinPath)(program.directory, `.cache`, file);
    const tmp = `${destination}.${Date.now()}`;
    return fs.writeFile(tmp, data).then(() => fs.move(tmp, destination, {
      overwrite: true
    }));
  };

  const result = await Promise.all([writeAndMove(`sync-requires.js`, syncRequires), writeAndMove(`async-requires.js`, asyncRequires), writeAndMove(`match-paths.json`, JSON.stringify(matchPaths, null, 4))]);
  return result;
};

const debouncedWriteAll = _.debounce(() => writeAll(store.getState()), 500, {
  leading: true
});
/**
 * Start listening to CREATE/DELETE_PAGE events so we can rewrite
 * files as required
 */


const startListener = () => {
  emitter.on(`CREATE_PAGE`, () => {
    debouncedWriteAll();
  });
  emitter.on(`CREATE_PAGE_END`, () => {
    debouncedWriteAll();
  });
  emitter.on(`DELETE_PAGE`, () => {
    debouncedWriteAll();
  });
  emitter.on(`DELETE_PAGE_BY_PATH`, () => {
    debouncedWriteAll();
  });
};

module.exports = {
  writeAll,
  resetLastHash,
  startListener
};
//# sourceMappingURL=requires-writer.js.map