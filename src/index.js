import {
  $debug,
  getExportNameForType,
  containsReactElement,
  PLUGIN_NAME,
  hasReactElementTypeAnnotationReturn,
} from './util';
import convertToPropTypes from './convertToPropTypes';
import {makePropTypesAstForExport, makePropTypesAstForPropTypesAssignment, setMakePropTypeImportNode} from './makePropTypesAst';

// maps between type alias name to prop types
let internalTypes = {};

// maps between type alias to import alias
let importedTypes = {};

// maps from imported-name+location to the local name
let addedImports = {};

let exportedTypes = {};
let suppress = false;
let omitRuntimeTypeExport = false;

const SUPPRESS_STRING = 'no babel-plugin-flow-react-proptypes';

// The template to use for the dead code elimination check
// if it passes, the prop types will be removed
// currently the 'deadCode' option is off by default, but this may change
const DEFAULT_DCE = `process.env.NODE_ENV === 'production'`;

// General control flow:
// Parse flow type annotations in index.js
// Convert to intermediate representation via convertToPropTypes.js
// Convert to prop-types AST in makePropTypesAst.js

// Indicates we shouldn't handle a node again
// TODO: use a Symbol or WeakMap
const SKIP = `BPFRPT_SKIP`;

const convertNodeToPropTypes = node => convertToPropTypes(
  node,
  importedTypes,
  internalTypes
);

const getPropsForTypeAnnotation = typeAnnotation => {
  let props = null;

  if (typeAnnotation.properties || typeAnnotation.type === 'GenericTypeAnnotation'
      || typeAnnotation.type === 'IntersectionTypeAnnotation'
      || typeAnnotation.type === 'AnyTypeAnnotation') {
    props = convertNodeToPropTypes(typeAnnotation);
  }
  else if (typeAnnotation.properties != null || typeAnnotation.type != null) {
    $debug('typeAnnotation not of expected type, not generating propTypes: ', typeAnnotation);
  }
  else {
    throw new Error(`Expected prop types, but found none. This is a bug in ${PLUGIN_NAME}`);
  }

  return props;
};

module.exports = function flowReactPropTypes(babel) {
  const t = babel.types;

  let opts = {};

  function shouldUseImport() {
    return opts.useESModules === true || !opts.deadCode;
  }

  const impTemplates = {
    named: babel.template(`import { LOCAL } from 'change me'`, { sourceType: 'module' }),
    renamed: babel.template(`import { SOURCE as LOCAL } from 'change me'`, { sourceType: 'module' }),
    default: babel.template(`import NAME from 'change me'`,  { sourceType: 'module' }),
    requireDefault: babel.template(`require(PATH)`),
    requireNamed: babel.template(`require(PATH).NAME`),
  };
  function getFromModule(path, { type = 'default', name, local = name, location }) {
    const tid = t.identifier;
    const tstr = t.stringLiteral;
    const key = `name:${location}:${name}`;

    if (shouldUseImport()) {
      if (!addedImports[key]) {
        const localName = local.replace(/[^a-zA-Z0-9]+/g, '_');
        const sourceName = name.replace(/[^a-zA-Z0-9]+/g, '_');
        addedImports[key] = localName;

        let toAdd = null;

        if (type === 'default') {
          toAdd = impTemplates.default({ NAME: tid(localName) });
        }
        else if (type === 'named') {
          if (localName === sourceName) {
            toAdd = impTemplates.named({ LOCAL: tid(localName) });
          }
          else {
            toAdd = impTemplates.renamed({ LOCAL: tid(localName), SOURCE: tid(sourceName) });
          }
        }
        if (toAdd) {
          toAdd.source.value = location;
          let ppath = path;
          do  {
            if (ppath.node && ppath.node.type === 'Program') break;
          } while (ppath = ppath.parentPath);
          if (ppath && ppath.node.body) {
            ppath.node.body.push(toAdd);
          }
        }
      }
      return tid(addedImports[key]);
    }
    else {
      if (type === 'default') {
        return impTemplates.requireDefault({ PATH: tstr(location) }).expression;
      }
      else if (type === 'named') {
        return impTemplates.requireNamed({ PATH: tstr(location), NAME: tid(name) }).expression;
      }
    }
  }

  function getFromPropTypesModule(path, name, isRequired) {
    const ptNode = getFromModule(path, { type: 'default', name: 'PropTypes', location: 'prop-types'});
    if (!name) return ptNode;
    const ptOptional = t.memberExpression(ptNode, t.identifier(name));
    if (!isRequired) return ptOptional;
    return t.memberExpression(ptOptional, t.identifier('isRequired'));
  }

  function addExportTypeDecl(path, exportName, exportValueNode = null) {
    if (!exportValueNode) {
      exportValueNode = t.identifier(exportName);
    }

    if (!opts.deadCode || shouldUseImport()) {
      if (!path.parentPath.isProgram()) return;
      const body = path.parentPath.node.body;
      const exportAst = t.exportNamedDeclaration(
        null,
        [
          t.exportSpecifier(
            t.identifier(exportName),
            exportValueNode,
          )
        ],
      );
      exportAst[SKIP] = true;
      body.push(exportAst);
    }
    else {
      // add the variable to the exports
      const exportAst = t.expressionStatement(t.callExpression(
        t.memberExpression(t.identifier('Object'), t.identifier('defineProperty')),
        [
          t.identifier('exports'),
          t.stringLiteral(exportName),
          t.objectExpression([
            t.objectProperty(t.identifier('value'), exportValueNode),
            t.objectProperty(t.identifier('configurable'), t.booleanLiteral(true)),
          ]),
        ]
      ));
      const exportsDefinedCondition = t.binaryExpression(
        '!==',
        t.unaryExpression(
          'typeof',
          t.identifier('exports')
        ),
        t.stringLiteral('undefined')
      );

      let ifCond = exportsDefinedCondition;
      if (opts.deadCode) {
        const dceConditional = t.unaryExpression('!', getDcePredicate());
        ifCond = t.logicalExpression(
          '&&',
          dceConditional,
          ifCond,
        );
      }

      const conditionalExportsAst = t.ifStatement(
        ifCond,
        exportAst
      );
      path.insertAfter(conditionalExportsAst);
    }
  }

  const _templateCache = {};
  function getDcePredicate() {
    // opts.deadCode could be a boolean (true for DEFAULT_DCE), or a string to be
    // used as a template
    // if it's falsy, then just return node without any wrapper
    if (!opts.deadCode) return null;

    // cache the template since it's going to be used a lot
    const templateCode = typeof opts.deadCode === 'string' ? opts.deadCode : DEFAULT_DCE;
    if (!_templateCache[templateCode]) {
      _templateCache[templateCode] = babel.template(templateCode);
    }

    // return a ternary
    const predicate = _templateCache[templateCode]({}).expression;
    return predicate;
  }

  function wrapInDceCheck(node) {
    const predicate = getDcePredicate(node);
    if (!predicate) return node;

    const conditional = t.conditionalExpression(
      predicate,
      t.nullLiteral(),
      node,
    );

    return conditional;
  }

  const isFunctionalReactComponent = path => {
    if ((path.type === 'ArrowFunctionExpression' || path.type === 'FunctionExpression') && !path.parent.id) {
      // Could be functions inside a React component
      return false;
    }
    if (hasReactElementTypeAnnotationReturn(path.node)) {
      return true;
    }
    if (containsReactElement(path.node)) {
      return true;
    }
    return false;
  };

  const findPresetProperties = (path, objectName, propertyName) => {
    let propNode = null;
    let propPath = null;

    path.traverse({
      ClassProperty(path) {
        if (path.node.key && path.node.key.name === propertyName) {
          propNode = path.node.value;
          propPath = path;
        }
      }
    });

    if (!propNode) {
      path.parentPath.traverse({
        ExpressionStatement(path) {
          if (!path.node.expression || !path.node.expression.left) {
            return;
          }

          if (
            path.node.expression.left.object &&
            path.node.expression.left.property &&
            path.node.expression.left.object.name === objectName &&
            path.node.expression.left.property.name === propertyName
          ) {
            propNode = path.node.expression.right;
            propPath = path;
          }
        }
      });
    }

    return [propNode, propPath];
  };

  const mergeExplicitPropTypes = (generatedProperties, path, name) => {
    const [explicitPropNode, explicitPropPath] =
      findPresetProperties(path, name, 'propTypes');

    if (!explicitPropNode || !explicitPropNode.properties) {
      return generatedProperties;
    }

    const generatedAndExplicitProperties =
      generatedProperties.concat(explicitPropNode.properties)
        .reduce((acc, i) => {
          if (!!i.key) {
            acc[i.key.name] = i;
          }
          else if (!!i.argument) {
            acc[i.argument.name] = i;
          }
          
          return acc;
        }, {});

    const mergedPropTypes =
      Object.keys(generatedAndExplicitProperties)
        .map(k => {
          const original = generatedAndExplicitProperties[k];
          // delete original line locations to avoid extra new lines
          delete original.start;
          delete original.end;
          return original;
        });

    explicitPropPath.remove();
    return mergedPropTypes;
  };

  const setDefaultPropsOptional = (generatedProperties, path, name) => {
    const [defaultPropNode] =
      findPresetProperties(path, name, 'defaultProps');

    if (!defaultPropNode || !defaultPropNode.properties) {
      return generatedProperties;
    }

    const defaultProps =
      defaultPropNode.properties.map(prop => prop.key.name);

    return generatedProperties.map(prop => {
      if (defaultProps.includes(prop.key)) {
        prop.value.isRequired = false;
      }

      return prop;
    });
  };

    /**
     * Adds propTypes or contextTypes annotations to code
     *
     * Extracts some shared logic from `annotate`.
     *
     * @param path
     * @param name
     * @param attribute - target member name ('propTypes' or 'contextTypes')
     * @param typesOrVar - propsOrVar / contextOrVar value
     */
  const addAnnotationsToAST = (path, name, attribute, typesOrVar) => {
    let attachPropTypesAST;
    // if type was exported, use the declared variable
    let valueNode = null;

    if (typeof typesOrVar === 'string'){
      valueNode = t.identifier(typesOrVar);

      if (name) {
        let inner = t.assignmentExpression(
          '=',
          t.memberExpression(t.identifier(name), t.identifier(attribute)),
          valueNode,
        );

        if (attribute === 'propTypes') {
          inner = wrapInDceCheck(inner);
        }

        attachPropTypesAST = t.expressionStatement(inner);
      }
    }
    // type was not exported, generate
    else {
      const propTypesAST = makePropTypesAstForPropTypesAssignment(typesOrVar);
      if (propTypesAST == null) {
        return;
      }

      valueNode = propTypesAST;
      if (attribute === 'propTypes') {
        valueNode = wrapInDceCheck(valueNode);
        if (valueNode.properties) {
          valueNode.properties = mergeExplicitPropTypes(valueNode.properties, path, name);
        }
      }

      attachPropTypesAST = t.expressionStatement(
        t.assignmentExpression(
          '=',
          t.memberExpression(t.identifier(name), t.identifier(attribute)),
          valueNode
        )
      );
    }

    if (!opts.noStatic && (path.type === 'ClassDeclaration' || path.type === 'ClassExpression')) {
      const newNode = t.classProperty(
        t.identifier(attribute),
        valueNode
      );
      newNode.static = true;
      path.node.body.body.push(newNode);
    }
    else if (attachPropTypesAST) {
      path.insertAfter(attachPropTypesAST);
    }
  };

    /**
     * Called when visiting a node.
     *
     * Converts the props param to AST and attaches it at the proper location,
     * depending on the path param.
     *
     *
     * @param path
     * @param propsOrVar - props or exported props variable reference
     * @param contextOrVar - context or exported context variable reference
     */
  const annotate = (path, propsOrVar, contextOrVar = null) => {
    let name = null;
    let targetPath;

    if (!opts.noStatic && (path.type === 'ClassDeclaration' || path.type === 'ClassExpression')) {
      if (path.node.id) {
        name = path.node.id.name;
      }
      targetPath = path;
    }
    else if (path.type === 'ArrowFunctionExpression' || path.type === 'FunctionExpression') {
      name = path.parent.id.name;
      const basePath = path.parentPath.parentPath;
      targetPath = t.isExportDeclaration(basePath.parent) ? basePath.parentPath : basePath;
    }
    else if (path.node.id) {
      name = path.node.id.name;
      targetPath = ['Program', 'BlockStatement'].indexOf(path.parent.type) >= 0 ? path : path.parentPath;
    }
    else {
      throw new Error(`babel-plugin-flow-react-proptypes attempted to add propTypes to a function/class with no name`);
    }

    if (propsOrVar) {
      if (propsOrVar.properties) {
        propsOrVar.properties =
          setDefaultPropsOptional(propsOrVar.properties, targetPath, name);
      }

      addAnnotationsToAST(targetPath, name, 'propTypes', propsOrVar);
    }

    if (contextOrVar) {
      addAnnotationsToAST(targetPath, name, 'contextTypes', contextOrVar);
    }
  };

  /**
   * Visitor for functions.
   *
   * Determines if a function is a functional react component and
   * inserts the proptypes and contexttypes AST via `annotate`.
   *
   * @param path
   */
  const functionVisitor = path => {
    if (!isFunctionalReactComponent(path)) {
      return;
    }

    // Check if this looks like a stateless react component with PropType reference:
    const firstParam = path.node.params[0];
    const typeAnnotation = firstParam
      && firstParam.typeAnnotation
      && firstParam.typeAnnotation.typeAnnotation;

    // Check if the component has context annotations
    const secondParam = path.node.params[1];
    const contextAnnotation = secondParam
      && secondParam.typeAnnotation
      && secondParam.typeAnnotation.typeAnnotation;

    let propsOrVar = null;
    if (!typeAnnotation) {
      $debug('Found stateless component without type definition');
    }
    else {
      propsOrVar = typeAnnotation.id && exportedTypes[typeAnnotation.id.name] ?
        exportedTypes[typeAnnotation.id.name] :
        getPropsForTypeAnnotation(typeAnnotation);
    }

    let contextOrVar;

    if (contextAnnotation) {
      contextOrVar = contextAnnotation.id && exportedTypes[contextAnnotation.id.name] ?
        exportedTypes[contextAnnotation.id.name] :
        getPropsForTypeAnnotation(contextAnnotation);
    }
    else {
      contextOrVar = null;
    }

    if (propsOrVar) {
      annotate(path, propsOrVar, contextOrVar);
    }
  };

  return {
    visitor: {
      Program(path, {opts: _opts}) {
        opts = _opts;
        internalTypes = {};
        importedTypes = {};
        exportedTypes = {};
        addedImports = {};

        setMakePropTypeImportNode(() => getFromPropTypesModule(path));

        suppress = false;
        omitRuntimeTypeExport = opts.omitRuntimeTypeExport || false;
        const directives = path.node.directives;
        if(directives && directives.length)  {
          const directive = directives[0];
          if (directive.value && directive.value.value === SUPPRESS_STRING) {
            suppress = true;
          }
        }
        if (this.file && this.file.opts && this.file.opts.filename) {
          if (this.file.opts.filename.indexOf('node_modules') >= 0) {
            // Suppress any file that lives in node_modules IF the
            // ignoreNodeModules setting is true
            suppress = opts.ignoreNodeModules;
          }
        }
      },
      "TypeAlias|InterfaceDeclaration|OpaqueType"(path) {
        if (suppress) return;
        $debug('TypeAlias/InterfaceDeclaration/OpaqueType found');

        const typeAliasName = path.node.id.name;
        if (!typeAliasName) {
          throw new Error('Did not find name for type alias');
        }

        const propTypes = convertNodeToPropTypes(path.node);
        internalTypes[typeAliasName] = propTypes;
      },
      "ClassExpression|ClassDeclaration"(path) {
        if (opts.noStatic && path.node.type === 'ClassExpression') return;

        if (path.node[SKIP]) return;
        path.node[SKIP] = true;

        if (suppress) return;
        const {superClass} = path.node;

        // check if we're extending React.Compoennt
        const extendsReactComponent = superClass && superClass.type === 'MemberExpression'
        && superClass.object.name === 'React'
        && (superClass.property.name === 'Component' || superClass.property.name === 'PureComponent');
        const extendsComponent = superClass
                                 && superClass.type === 'Identifier'
                                 && (superClass.name === 'Component' || superClass.name === 'PureComponent');
        if (!extendsReactComponent && !extendsComponent) {
          $debug('Found a class that isn\'t a react component', superClass);
          return;
        }


        let propTypes = null, contextTypes = null;
        // And have type as property annotations
        path.node.body.body.forEach(bodyNode => {
          if (bodyNode && bodyNode.key.name === 'props' && bodyNode.typeAnnotation) {
            const annotation = bodyNode.typeAnnotation.typeAnnotation;
            const props = getPropsForTypeAnnotation(annotation);
            if (!props) {
              throw new TypeError('Couldn\'t process \`class { props: This }`');
            }

            propTypes = props;

            return;
          }

          if (bodyNode && bodyNode.key.name === 'context' && bodyNode.typeAnnotation) {
            const annotation = bodyNode.typeAnnotation.typeAnnotation;
            const context = getPropsForTypeAnnotation(annotation);
            if (!context) {
              throw new TypeError('Couldn\'t process \`class { context: This }`');
            }

            contextTypes = context;
          }
        });

        // or Component<void, Props, Context>
        const secondSuperParam = getPropsTypeParam(path.node);
        if (secondSuperParam && secondSuperParam.type === 'GenericTypeAnnotation') {
          const typeAliasName = secondSuperParam.id.name;
          if (typeAliasName === 'Object') return;
          const props = internalTypes[typeAliasName] || (importedTypes[typeAliasName] && importedTypes[typeAliasName].accessNode);
          if (!props) {
            $debug(`Couldn't find type "${typeAliasName}"`);
            return;
          }

          propTypes = props;
        }

        if (secondSuperParam && (secondSuperParam.type === 'ObjectTypeAnnotation' || secondSuperParam.type === 'IntersectionTypeAnnotation')) {
          propTypes = convertToPropTypes(secondSuperParam, importedTypes, internalTypes);
        }

        const thirdSuperParam = getContextTypeParam(path.node);
        if (thirdSuperParam && thirdSuperParam.type === 'GenericTypeAnnotation') {
          const typeAliasName = thirdSuperParam.id.name;
          if (typeAliasName === 'Object') return;
          const props = internalTypes[typeAliasName] || (importedTypes[typeAliasName] && importedTypes[typeAliasName].accessNode);
          if (!props) {
            throw new TypeError(`Couldn't find type "${typeAliasName}"`);
          }

          contextTypes = props;
        }

        annotate(path, propTypes, contextTypes);
      },

      FunctionExpression(path) {
        if (suppress) return;
        return functionVisitor(path);
      },

      FunctionDeclaration(path) {
        if (suppress) return;
        return functionVisitor(path);
      },

      ArrowFunctionExpression(path) {
        if (suppress) return;
        return functionVisitor(path);
      },

      // See issue:
      /**
       * Processes exported type aliases.
       *
       * This function also adds something to the AST directly, instead
       * of invoking annotate.
       *
       * @param path
       * @constructor
       */
      ExportNamedDeclaration(path) {
        if (suppress) return;
        const {node} = path;

        if (node.exportKind === 'type' && node.source && node.source.value) {
          for (const spec of node.specifiers) {
            const typeName = spec.local.name;
            getFromModule(path, {
              type: 'named',
              name: getExportNameForType(typeName),
              location: node.source.value,
            });
            addExportTypeDecl(path, getExportNameForType(typeName));
          }

          return;
        }

        if (node.exportKind === 'type' && !node.source && !node.declaration) {
          for (const spec of node.specifiers) {
            if (!t.isIdentifier(spec.local)) continue;

            const imported = importedTypes[spec.local.name];
            if (!imported) continue;

            if (spec.local.name !== spec.exported.name) {
              // TODO: handle this properly
              continue;
            }

            addExportTypeDecl(path, getExportNameForType(spec.local.name), imported.accessNode);
          }

          return;
        }

        let declarationObject = null;
        if (!node.declaration) return;
        if (node.declaration.type === 'TypeAlias') {
          declarationObject = node.declaration.right;
        }
        if (node.declaration.type === 'OpaqueType') {
          declarationObject = node.declaration.impltype;
        }
        if (node.declaration.type === 'InterfaceDeclaration') {
          declarationObject = node.declaration.body;
        }

        if (!declarationObject) return;

        const name = node.declaration.id.name;
        const propTypes = convertNodeToPropTypes(declarationObject);
        internalTypes[name] = propTypes;

        const propTypesAst = makePropTypesAstForExport(propTypes);

        // create a variable for reuse
        const exportName = getExportNameForType(name);
        exportedTypes[name] = exportName;
        const variableDeclarationAst = t.variableDeclaration(
          'var',
          [
            t.variableDeclarator(
              t.identifier(exportName),
              wrapInDceCheck(propTypesAst)
            )
          ]
        );
        path.insertBefore(variableDeclarationAst);

        if (!omitRuntimeTypeExport) {
          if (path.node[SKIP]) return;
          addExportTypeDecl(path, exportName);
        }
      },
      ImportDeclaration(path) {
        if (suppress) return;

        const {node} = path;

        if (/^@?\w/.test(node.source.value) && node.source.value !== 'react') return;

        // https://github.com/brigand/babel-plugin-flow-react-proptypes/issues/62
        // if (node.source.value[0] !== '.') {
        //   return;
        // }
        node.specifiers.forEach((specifier) => {
          if (node.importKind !== 'type' && specifier.importKind !== 'type') return;

          const typeName = specifier.local.name;
          const originalTypeName = specifier.type === 'ImportDefaultSpecifier'
            ? typeName
            : specifier.imported.name;
          // Store the name the type so we can use it later. We do
          // mark it as importedTypes because we do handle these
          // differently than internalTypes.
          // imported types are basically realized as imports;
          // because we can be somewhat sure that we generated
          // the proper exported propTypes in the imported file
          // Later, we will check importedTypes to determine if
          // we want to put this as a 'raw' type in our internal
          // representation
          importedTypes[typeName] = { localName: originalTypeName, exportName: getExportNameForType(originalTypeName), accessNode: null };

          // https://github.com/brigand/babel-plugin-flow-react-proptypes/issues/129
          if (node.source.value === 'react' && typeName === 'ComponentType') {
            const ptFunc = getFromPropTypesModule(path, 'func');
            importedTypes[typeName].accessNode = ptFunc;
            return;
          }
          if (node.source.value === 'react' && typeName === 'Node') {
            const ptFunc = getFromPropTypesModule(path, 'node');
            importedTypes[typeName].accessNode = ptFunc;
            return;
          }


          const accessNode = getFromModule(path, {
            type: 'named',
            name: getExportNameForType(originalTypeName),
            local: getExportNameForType(typeName),
            location: node.source.value,
          });

          importedTypes[typeName].accessNode = accessNode;
        });
      }
    }
  };
};


function getPropsTypeParam(node) {
  if (!node) return null;
  if (!node.superTypeParameters) return null;
  const superTypes = node.superTypeParameters;
  if (superTypes.params.length === 2) {
    return superTypes.params[0];
  }
  else if (superTypes.params.length === 3) {
    return superTypes.params[0];
  }
  else if (superTypes.params.length === 1) {
    return superTypes.params[0];
  }
  return null;
}

function getContextTypeParam(node) {
  if (!node) return null;
  if (!node.superTypeParameters) return null;
  const superTypes = node.superTypeParameters;
  if (superTypes.params.length === 3) {
    return superTypes.params[2];
  }
  return null;
}
