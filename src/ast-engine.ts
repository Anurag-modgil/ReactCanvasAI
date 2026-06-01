import * as recast from 'recast';
import { parse as babelParse } from '@babel/parser';

const tsxParser = {
  parse(source: string) {
    return babelParse(source, {
      sourceType: 'module',
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      tokens: true, // IMPORTANT for Recast comment/formatting retention
      plugins: [
        'jsx',
        'typescript',
        'decorators-legacy',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'exportDefaultFrom'
      ]
    });
  }
};

/**
 * Checks if a JSX opening element matches the specified line and column.
 * We allow a small column offset (e.g., within 5 characters) because compilers/transpilers
 * and text formatting might slightly shift column numbers.
 */
function isMatchingElement(node: any, line: number, column: number): boolean {
  if (!node.loc) return false;
  const nodeLine = node.loc.start.line;
  const nodeCol = node.loc.start.column;

  if (nodeLine !== line) return false;
  if (column > 0) {
    // If column is provided, check if it's within a reasonable distance
    return Math.abs(nodeCol - column) <= 5;
  }
  return true;
}

/**
 * Safely updates or adds the `className` attribute of a JSX element at the specified line and column.
 */
export function updateElementClasses(sourceCode: string, line: number, column: number, newClasses: string): string {
  const ast = recast.parse(sourceCode, { parser: tsxParser });
  let modified = false;

  recast.visit(ast, {
    visitJSXOpeningElement(path) {
      const node = path.node;
      if (isMatchingElement(node, line, column)) {
        if (!node.attributes) {
          node.attributes = [];
        }
        const builders = recast.types.builders;
        
        // Find existing className attribute
        const classNameAttrIdx = node.attributes.findIndex(
          (attr: any) => attr.type === 'JSXAttribute' && attr.name.name === 'className'
        );

        if (classNameAttrIdx !== -1) {
          const classNameAttr = node.attributes[classNameAttrIdx] as any;
          if (classNameAttr.value.type === 'StringLiteral') {
            classNameAttr.value.value = newClasses;
            modified = true;
          } else if (classNameAttr.value.type === 'JSXExpressionContainer') {
            // Handle template literals if they are simple or if it contains a StringLiteral
            const expr = classNameAttr.value.expression;
            if (expr.type === 'StringLiteral') {
              expr.value = newClasses;
              modified = true;
            } else if (expr.type === 'TemplateLiteral' && expr.quasis.length === 1) {
              expr.quasis[0].value.raw = newClasses;
              expr.quasis[0].value.cooked = newClasses;
              modified = true;
            } else {
              console.warn('[ReactCanvas AST] className attribute is complex expression; replacing with StringLiteral.');
              classNameAttr.value = builders.stringLiteral(newClasses);
              modified = true;
            }
          }
        } else {
          // Attribute doesn't exist, create it
          const newAttr = builders.jsxAttribute(
            builders.jsxIdentifier('className'),
            builders.stringLiteral(newClasses)
          );
          node.attributes.push(newAttr);
          modified = true;
        }
        return false; // Stop traversing this subtree
      }
      this.traverse(path);
    }
  });

  if (!modified) {
    console.warn(`[ReactCanvas AST] Could not find or modify element at line ${line}, col ${column}`);
  }

  return recast.print(ast).code;
}

/**
 * Safely updates the text content of a JSX element at the specified line and column.
 */
export function updateElementText(sourceCode: string, line: number, column: number, newText: string): string {
  const ast = recast.parse(sourceCode, { parser: tsxParser });
  let modified = false;

  recast.visit(ast, {
    visitJSXElement(path) {
      const opening = path.node.openingElement;
      if (isMatchingElement(opening, line, column)) {
        const builders = recast.types.builders;

        if (!path.node.children) {
          path.node.children = [];
        }
        // If the element is self-closing (<div />), convert it to open/close tags to insert text
        if (opening.selfClosing) {
          opening.selfClosing = false;
          path.node.closingElement = builders.jsxClosingElement(opening.name);
          path.node.children = [builders.jsxText(newText)];
          modified = true;
          return false;
        }

        // Search for existing text children to replace
        let textChildIdx = path.node.children.findIndex((child: any) => child.type === 'JSXText');
        if (textChildIdx !== -1) {
          // Replace content of the first text child, clear out any other text children
          (path.node.children[textChildIdx] as any).value = newText;
          // Keep only this text child and any nested JSX elements
          path.node.children = path.node.children.filter(
            (child: any, idx: number) => child.type !== 'JSXText' || idx === textChildIdx
          );
          modified = true;
        } else {
          // If no text children exist, prepend text child
          path.node.children.unshift(builders.jsxText(newText));
          modified = true;
        }
        return false;
      }
      this.traverse(path);
    }
  });

  return recast.print(ast).code;
}

/**
 * Safely updates inline styles for a JSX element at the specified line and column.
 * Expects newStyles to be a record of camelCased style properties and values.
 */
export function updateElementStyles(
  sourceCode: string,
  line: number,
  column: number,
  newStyles: Record<string, string | number>
): string {
  const ast = recast.parse(sourceCode, { parser: tsxParser });
  let modified = false;

  recast.visit(ast, {
    visitJSXOpeningElement(path) {
      const node = path.node;
      if (isMatchingElement(node, line, column)) {
        if (!node.attributes) {
          node.attributes = [];
        }
        const builders = recast.types.builders;

        const styleAttrIdx = node.attributes.findIndex(
          (attr: any) => attr.type === 'JSXAttribute' && attr.name.name === 'style'
        );

        // Build properties for the ObjectExpression
        const properties = Object.entries(newStyles).map(([key, value]) => {
          const valNode = typeof value === 'number'
            ? builders.numericLiteral(value)
            : builders.stringLiteral(String(value));
          return builders.objectProperty(builders.identifier(key), valNode);
        });

        const newStyleValue = builders.jsxExpressionContainer(
          builders.objectExpression(properties)
        );

        if (styleAttrIdx !== -1) {
          const styleAttr = node.attributes[styleAttrIdx] as any;
          if (styleAttr.value.type === 'JSXExpressionContainer' && styleAttr.value.expression.type === 'ObjectExpression') {
            const expr = styleAttr.value.expression;
            
            // Merge properties: update existing, append new
            for (const [key, val] of Object.entries(newStyles)) {
              const existingPropIdx = expr.properties.findIndex(
                (p: any) => p.type === 'ObjectProperty' && p.key.name === key
              );
              const valNode = typeof val === 'number'
                ? builders.numericLiteral(val)
                : builders.stringLiteral(String(val));
              
              if (existingPropIdx !== -1) {
                expr.properties[existingPropIdx].value = valNode;
              } else {
                expr.properties.push(builders.objectProperty(builders.identifier(key), valNode));
              }
            }
            modified = true;
          } else {
            // style attribute is a dynamic expression or string; overwrite it with our ObjectExpression
            styleAttr.value = newStyleValue;
            modified = true;
          }
        } else {
          // style attribute does not exist; add it
          const styleAttr = builders.jsxAttribute(
            builders.jsxIdentifier('style'),
            newStyleValue
          );
          node.attributes.push(styleAttr);
          modified = true;
        }
        return false;
      }
      this.traverse(path);
    }
  });

  return recast.print(ast).code;
}

/**
 * Self-Contained LCS unified line diff generator.
 */
export function generateLineDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split(/\r?\n/);
  const newLines = newStr.split(/\r?\n/);

  // Compute DP table for LCS
  const dp: number[][] = Array(oldLines.length + 1).fill(0).map(() => Array(newLines.length + 1).fill(0));

  for (let i = 1; i <= oldLines.length; i++) {
    for (let j = 1; j <= newLines.length; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let i = oldLines.length;
  let j = newLines.length;
  const diffLines: string[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      // Line is unchanged
      diffLines.push(`  ${oldLines[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      // Line added
      diffLines.push(`+ ${newLines[j - 1]}`);
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      // Line deleted
      diffLines.push(`- ${oldLines[i - 1]}`);
      i--;
    }
  }

  // Reverse to put lines back in original order
  const resultLines = diffLines.reverse();
  return resultLines.join('\n');
}
