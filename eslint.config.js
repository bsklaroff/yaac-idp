import globals from 'globals'
import stylistic from '@stylistic/eslint-plugin'
import tseslint from 'typescript-eslint'

// The base rules are yaac's (its eslint.config.js), without the zones that
// police that repo's package and layer boundaries.

// A module names another folder's by its `#server/…` or `#web/…` specifier
// (package.json `imports`), so a file can move without its imports changing.
const RELATIVE_PARENT = { group: ['..*'], message: 'Relative parent imports are not allowed.' }

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'test/server/web-root'] },
  {
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
    ],
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.json', './src/web/tsconfig.json', './test/web/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@stylistic': stylistic,
    },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [RELATIVE_PARENT] },
      ],
      'no-restricted-syntax': ['error', 'ImportExpression'],
      // A caught error is unknown; passing it on to reject() is as fine as rethrowing it.
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingUnknown: true }],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'avoidEscape' }],
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/array-bracket-spacing': ['error', 'never'],
      '@stylistic/no-trailing-spaces': ['error'],
      '@stylistic/arrow-parens': ['error', 'always'],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  {
    files: ['src/web/**/*.{ts,tsx}', 'test/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },

  // process.env may only be read in config.ts, which names every setting
  // the issuer has.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: { 'no-process-env': 'error' },
  },
  {
    files: ['src/server/config.ts'],
    rules: { 'no-process-env': 'off' },
  },
)
