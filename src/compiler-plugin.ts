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
 * Transforms JSX source code by injecting data-rc-file, data-rc-line, and data-rc-column attributes.
 */
export function transformJSX(code: string, filePath: string): string {
  // Simple check to skip empty or clearly non-JSX files before heavy parsing
  if (!code.includes('<') && !code.includes('JSX')) {
    return code;
  }

  try {
    const ast = recast.parse(code, { parser: tsxParser });
    const builders = recast.types.builders;

    recast.visit(ast, {
      visitJSXOpeningElement(path) {
        const node = path.node;
        
        // Skip JSX fragment shorthand <>...</>
        if (!node.name || (node.name.type === 'JSXIdentifier' && node.name.name === '')) {
          this.traverse(path);
          return;
        }

        const loc = node.loc;
        if (loc) {
          const line = loc.start.line;
          const col = loc.start.column;

          if (!node.attributes) {
            node.attributes = [];
          }

          // Check if data-rc-file already exists to avoid duplicate injection
          const hasFileAttr = node.attributes.some(
            (attr: any) => attr.type === 'JSXAttribute' && attr.name.name === 'data-rc-file'
          );

          if (!hasFileAttr) {
            node.attributes.push(
              builders.jsxAttribute(
                builders.jsxIdentifier('data-rc-file'),
                builders.stringLiteral(filePath)
              ),
              builders.jsxAttribute(
                builders.jsxIdentifier('data-rc-line'),
                builders.stringLiteral(String(line))
              ),
              builders.jsxAttribute(
                builders.jsxIdentifier('data-rc-column'),
                builders.stringLiteral(String(col))
              )
            );
          }
        }

        this.traverse(path);
      }
    });

    return recast.print(ast).code;
  } catch (err) {
    // If parsing fails (e.g. because of custom syntax), fall back to original code
    console.warn(`[ReactCanvas AI] Failed to parse and instrument ${filePath}:`, err);
    return code;
  }
}

/**
 * Vite plugin for ReactCanvas AI.
 * Automatically instruments JSX files in development mode.
 */
export function reactCanvasVitePlugin() {
  return {
    name: 'vite-plugin-react-canvas',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const cleanId = id.split('?')[0];
      // Instrument only workspace files (.jsx and .tsx), skip node_modules
      if (cleanId.includes('node_modules') || (!cleanId.endsWith('.jsx') && !cleanId.endsWith('.tsx'))) {
        return null;
      }
      
      console.log(`[ReactCanvas Vite Plugin] Instrumenting: ${cleanId}`);
      try {
        const transformed = transformJSX(code, cleanId);
        return {
          code: transformed,
          map: null // Leave sourcemaps unmodified
        };
      } catch (e) {
        console.error(`[ReactCanvas Vite Plugin] Error instrumenting ${cleanId}:`, e);
        return null;
      }
    }
  };
}
