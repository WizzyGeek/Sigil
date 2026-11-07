import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Run the source with Node's test runner, without adding a second bundler.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context) }
    catch (error) {
      if (!specifier.startsWith('.')) throw error
      for (const extension of ['.ts', '.tsx']) {
        try { return nextResolve(specifier + extension, context) } catch { /* Try TSX next. */ }
      }
      throw error
    }
  },
  load(url, context, nextLoad) {
    if (!/\.tsx?$/.test(url)) return nextLoad(url, context)
    const source = readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '(globalThis.__TEST_ENV__ ?? {})')
    return { format: 'module', source: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText, shortCircuit: true }
  },
})
