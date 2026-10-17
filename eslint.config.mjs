import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores([
    'node_modules/',
    'out/',
    'dist/',
    'release/',
    'build/',
    '.polly/',
    'test-results/',
    'e2e-artifacts/',
  ]),
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['e2e/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // The rendering-test harness: an Electron main and a sandboxed preload, plain CommonJS.
    files: ['e2e/harness/*.cjs'],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
  },
  {
    // Classic script loaded from index.html before first paint.
    files: ['src/renderer/public/*.js'],
    languageOptions: { globals: globals.browser, sourceType: 'script' },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // toMatchObject (Vitest and Playwright) treats a RegExp as an object with no keys, so a
    // regex value matches anything. Use expect.stringMatching(re) instead.
    files: ['**/*.test.{ts,tsx}', 'e2e/**/*.ts'],
    // TODO: drop once PR #30 converts the remaining run-shell assertions.
    ignores: ['src/main/tools/run-shell.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.property.name=/^(toMatchObject|objectContaining)$/] > .arguments :matches(Property > Literal.value, ArrayExpression > Literal)[regex]',
          message:
            'A RegExp here matches any value (toMatchObject) or only another RegExp (objectContaining). Use expect.stringMatching(re).',
        },
      ],
    },
  },
  prettier,
])
