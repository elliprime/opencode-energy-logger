import eslint from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'viewer/'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  stylistic.configs.customize({ quotes: 'single' }),
  {
    rules: {
      'curly': ['error', 'all'],
      '@stylistic/brace-style': ['error', '1tbs'],
    },
  },
)
