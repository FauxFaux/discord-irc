import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist/**']),
  {
    files: ['{lib,test}/**/*.{js,mjs,cjs,ts,mts,cts}'],
    plugins: { js },
    extends: ['js/recommended'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.mocha,
        ...globals.chai,
      },
    },
  },
  {
    files: ['lib/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^\\.{1,2}/(?!.*\\.(?:js|json)$)',
          message: 'Use an explicit .js extension for relative JavaScript imports.',
        }],
      }],
    },
  },
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    }
  }
]);
