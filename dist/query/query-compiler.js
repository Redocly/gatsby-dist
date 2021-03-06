"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

exports.__esModule = true;
exports.default = compile;
exports.resolveThemes = exports.Runner = void 0;

var _defineProperty2 = _interopRequireDefault(require("@babel/runtime/helpers/defineProperty"));

var _path = _interopRequireDefault(require("path"));

var _glob = _interopRequireDefault(require("glob"));

var _graphql = require("graphql");

var _relayCompiler = require("@gatsbyjs/relay-compiler");

var _RelayParser = _interopRequireDefault(require("@gatsbyjs/relay-compiler/lib/RelayParser"));

var _ASTConvert = _interopRequireDefault(require("@gatsbyjs/relay-compiler/lib/ASTConvert"));

var _GraphQLCompilerContext = _interopRequireDefault(require("@gatsbyjs/relay-compiler/lib/GraphQLCompilerContext"));

var _filterContextForNode = _interopRequireDefault(require("@gatsbyjs/relay-compiler/lib/filterContextForNode"));

var _gatsbyDependents = _interopRequireDefault(require("../utils/gatsby-dependents"));

var _redux = require("../redux");

var _fileParser = _interopRequireDefault(require("./file-parser"));

var _GraphQLIRPrinter = _interopRequireDefault(require("@gatsbyjs/relay-compiler/lib/GraphQLIRPrinter"));

var _graphqlErrors = require("./graphql-errors");

var _reporter = _interopRequireDefault(require("gatsby-cli/lib/reporter"));

var _errorParser = _interopRequireDefault(require("./error-parser"));

const normalize = require(`normalize-path`);

const levenshtein = require(`fast-levenshtein`);

const _ = require(`lodash`);

const {
  boundActionCreators
} = require(`../redux/actions`);

const websocketManager = require(`../utils/websocket-manager`);

const {
  printTransforms
} = _relayCompiler.IRTransforms;

const {
  ValuesOfCorrectTypeRule,
  FragmentsOnCompositeTypesRule,
  KnownTypeNamesRule,
  LoneAnonymousOperationRule,
  PossibleFragmentSpreadsRule,
  ScalarLeafsRule,
  VariablesAreInputTypesRule,
  VariablesInAllowedPositionRule,
  Kind,
  print
} = require(`graphql`);

const validationRules = [ValuesOfCorrectTypeRule, FragmentsOnCompositeTypesRule, KnownTypeNamesRule, LoneAnonymousOperationRule, PossibleFragmentSpreadsRule, ScalarLeafsRule, VariablesAreInputTypesRule, VariablesInAllowedPositionRule];
let lastRunHadErrors = null;
const overlayErrorID = `graphql-compiler`;

const resolveThemes = (themes = []) => themes.reduce((merged, theme) => {
  merged.push(theme.themeDir);
  return merged;
}, []);

exports.resolveThemes = resolveThemes;

class Runner {
  constructor(base, additional, schema) {
    (0, _defineProperty2.default)(this, "base", void 0);
    (0, _defineProperty2.default)(this, "additional", void 0);
    (0, _defineProperty2.default)(this, "schema", void 0);
    (0, _defineProperty2.default)(this, "errors", void 0);
    (0, _defineProperty2.default)(this, "fragmentsDir", void 0);
    this.base = base;
    this.additional = additional;
    this.schema = schema;
  }

  reportError(message) {
    const queryErrorMessage = `${_reporter.default.format.red(`GraphQL Error`)} ${message}`;

    if (process.env.gatsby_executing_command === `develop`) {
      websocketManager.emitError(overlayErrorID, queryErrorMessage);
      lastRunHadErrors = true;
    }
  }

  async compileAll() {
    let nodes = await this.parseEverything();
    return await this.write(nodes);
  }

  async parseEverything() {
    const filesRegex = `*.+(t|j)s?(x)`; // Pattern that will be appended to searched directories.
    // It will match any .js, .jsx, .ts, and .tsx files, that are not
    // inside <searched_directory>/node_modules.

    const pathRegex = `/{${filesRegex},!(node_modules)/**/${filesRegex}}`;
    const modulesThatUseGatsby = await (0, _gatsbyDependents.default)();
    let files = [_path.default.join(this.base, `src`), _path.default.join(this.base, `.cache`, `fragments`)].concat(this.additional.map(additional => _path.default.join(additional, `src`))).concat(modulesThatUseGatsby.map(module => module.path)).reduce((merged, folderPath) => merged.concat(_glob.default.sync(_path.default.join(folderPath, pathRegex), {
      nodir: true
    })), []);
    files = files.filter(d => !d.match(/\.d\.ts$/));
    files = files.map(normalize); // We should be able to remove the following and preliminary tests do suggest
    // that they aren't needed anymore since we transpile node_modules now
    // However, there could be some cases (where a page is outside of src for example)
    // that warrant keeping this and removing later once we have more confidence (and tests)
    // Ensure all page components added as they're not necessarily in the
    // pages directory e.g. a plugin could add a page component. Plugins
    // *should* copy their components (if they add a query) to .cache so that
    // our babel plugin to remove the query on building is active.
    // Otherwise the component will throw an error in the browser of
    // "graphql is not defined".

    files = files.concat(Array.from(_redux.store.getState().components.keys(), c => normalize(c)));
    files = _.uniq(files);
    let parser = new _fileParser.default();
    return await parser.parseFiles(files);
  }

  async write(nodes) {
    const compiledNodes = new Map();
    const namePathMap = new Map();
    const nameDefMap = new Map();
    const nameErrorMap = new Map();
    const documents = [];
    const fragmentMap = new Map();

    for (let [filePath, doc] of nodes.entries()) {
      let errors = (0, _graphql.validate)(this.schema, doc, validationRules);

      if (errors && errors.length) {
        const locationOfGraphQLDocInSourceFile = doc.definitions[0].templateLoc;

        _reporter.default.panicOnBuild(errors.map(error => {
          const graphqlLocation = error.locations[0]; // get location of error relative to soure file (not just graphql text)

          const location = {
            start: {
              line: graphqlLocation.line + locationOfGraphQLDocInSourceFile.start.line - 1,
              column: (graphqlLocation.line === 0 ? locationOfGraphQLDocInSourceFile.start.column - 1 : 0) + graphqlLocation.column
            }
          };
          return (0, _errorParser.default)({
            message: error.message,
            filePath,
            location
          });
        }));

        this.reportError((0, _graphqlErrors.graphqlValidationError)(errors, filePath));
        boundActionCreators.queryExtractionGraphQLError({
          componentPath: filePath
        });
        return compiledNodes;
      } // The way we currently export fragments requires duplicated ones
      // to be filtered out since there is a global Fragment namespace
      // We maintain a top level fragment Map to keep track of all definitions
      // of thge fragment type and to filter them out if theythey've already been
      // declared before


      doc.definitions = doc.definitions.filter(definition => {
        if (definition.kind === Kind.FRAGMENT_DEFINITION) {
          const fragmentName = definition.name.value;

          if (fragmentMap.has(fragmentName)) {
            if (print(definition) === fragmentMap.get(fragmentName)) {
              return false;
            }
          } else {
            fragmentMap.set(fragmentName, print(definition));
          }
        }

        return true;
      });
      documents.push(doc);
      doc.definitions.forEach(def => {
        const name = def.name.value;
        namePathMap.set(name, filePath);
        nameDefMap.set(name, def);
      });
    }

    let compilerContext = new _GraphQLCompilerContext.default(this.schema);

    try {
      compilerContext = compilerContext.addAll(_ASTConvert.default.convertASTDocuments(this.schema, documents, validationRules, _RelayParser.default.transform.bind(_RelayParser.default)));
    } catch (error) {
      const {
        formattedMessage,
        docName,
        message,
        codeBlock
      } = (0, _graphqlErrors.graphqlError)(namePathMap, nameDefMap, error);
      nameErrorMap.set(docName, {
        formattedMessage,
        message,
        codeBlock
      });
      boundActionCreators.queryExtractionGraphQLError({
        componentPath: namePathMap.get(docName),
        error: formattedMessage
      });
      const filePath = namePathMap.get(docName);
      const structuredError = (0, _errorParser.default)({
        message,
        filePath
      });

      _reporter.default.panicOnBuild(structuredError); // report error to browser
      // TODO: move browser error overlay reporting to reporter


      this.reportError(formattedMessage);
      return false;
    } // relay-compiler v1.5.0 added "StripUnusedVariablesTransform" to
    // printTransforms. Unfortunately it currently doesn't detect variables
    // in input objects widely used in gatsby, and therefore removing
    // variable declaration from queries.
    // As a temporary workaround remove that transform by slicing printTransforms.


    const printContext = printTransforms.slice(0, -1).reduce((ctx, transform) => transform(ctx, this.schema), compilerContext);
    const fragments = [];
    compilerContext.documents().forEach(node => {
      if (node.kind === `Fragment`) {
        fragments.push(node.name);
      }
    });
    compilerContext.documents().forEach(node => {
      if (node.kind !== `Root`) return;
      const {
        name
      } = node;
      let filePath = namePathMap.get(name) || ``;

      if (compiledNodes.has(filePath)) {
        let otherNode = compiledNodes.get(filePath);
        this.reportError((0, _graphqlErrors.multipleRootQueriesError)(filePath, nameDefMap.get(name), otherNode && nameDefMap.get(otherNode.name)));
        boundActionCreators.queryExtractionGraphQLError({
          componentPath: filePath
        });
        return;
      }

      let text;

      try {
        text = (0, _filterContextForNode.default)(printContext.getRoot(name), printContext).documents().map(_GraphQLIRPrinter.default.print).join(`\n`);
      } catch (error) {
        var _fragments$map$filter;

        const regex = /Unknown\sdocument\s`(.*)`/gm;
        const str = error.toString();
        let m;
        let fragmentName;

        while ((m = regex.exec(str)) !== null) {
          // This is necessary to avoid infinite loops with zero-width matches
          if (m.index === regex.lastIndex) regex.lastIndex++;
          fragmentName = m[1];
        }

        const closestFragment = (_fragments$map$filter = fragments.map(f => {
          return {
            fragment: f,
            score: levenshtein.get(fragmentName, f)
          };
        }).filter(f => f.score < 10).sort((a, b) => a.score > b.score)[0]) === null || _fragments$map$filter === void 0 ? void 0 : _fragments$map$filter.fragment;

        _reporter.default.panicOnBuild({
          id: `85908`,
          filePath,
          context: {
            fragmentName,
            closestFragment
          }
        });
      }

      const query = {
        name,
        text,
        originalText: nameDefMap.get(name).text,
        path: filePath,
        isHook: nameDefMap.get(name).isHook,
        isStaticQuery: nameDefMap.get(name).isStaticQuery,
        hash: nameDefMap.get(name).hash
      };

      if (query.isStaticQuery) {
        query.id = `sq--` + _.kebabCase(`${_path.default.relative(_redux.store.getState().program.directory, filePath)}`);
      }

      if (query.isHook && process.env.NODE_ENV === `production` && typeof require(`react`).useContext !== `function`) {
        _reporter.default.panicOnBuild(`You're likely using a version of React that doesn't support Hooks\n` + `Please update React and ReactDOM to 16.8.0 or later to use the useStaticQuery hook.`);
      }

      compiledNodes.set(filePath, query);
    });

    if (process.env.gatsby_executing_command === `develop` && lastRunHadErrors) {
      websocketManager.emitError(overlayErrorID, null);
      lastRunHadErrors = false;
    }

    return compiledNodes;
  }

}

exports.Runner = Runner;

async function compile() {
  // TODO: swap plugins to themes
  const {
    program,
    schema,
    themes,
    flattenedPlugins
  } = _redux.store.getState();

  const runner = new Runner(program.directory, resolveThemes(themes.themes ? themes.themes : flattenedPlugins.map(plugin => {
    return {
      themeDir: plugin.pluginFilepath
    };
  })), schema);
  const queries = await runner.compileAll();
  return queries;
}
//# sourceMappingURL=query-compiler.js.map