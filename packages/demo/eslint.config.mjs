import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import eslintPluginSvelte from 'eslint-plugin-svelte'
import globals from 'globals'
import svelteParser from 'svelte-eslint-parser'
import typescriptEslint from 'typescript-eslint'

export default typescriptEslint.config(
  js.configs.recommended,
  ...typescriptEslint.configs.recommended,
  ...eslintPluginSvelte.configs['flat/recommended'],
  eslintConfigPrettier,
  ...eslintPluginSvelte.configs['flat/prettier'],
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: typescriptEslint.parser,
        extraFileExtensions: ['.svelte'],
      },
    },
  },
  {
    files: ['**/*.svelte.ts'],
    languageOptions: {
      parser: typescriptEslint.parser,
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'svelte/no-navigation-without-resolve': 'off',
    },
  },
  {
    ignores: ['**/.svelte-kit', '**/build', '**/dist', '**/node_modules', '**/package'],
  },
)
