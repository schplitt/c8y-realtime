import schplitt from '@schplitt/eslint-config'

export default schplitt({
}).append({
  // README code fences are illustrative snippets, not runnable modules: allow
  // top-level await, single-shot `for await … break`, console and void.
  files: ['**/*.md/**'],
  rules: {
    'antfu/no-top-level-await': 'off',
    'no-unreachable-loop': 'off',
    'no-void': 'off',
    'no-console': 'off',
  },
})
