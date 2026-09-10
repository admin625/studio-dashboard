import globals from 'globals'

/**
 * ONE RULE, ON PURPOSE: no-undef.
 *
 * WHY. `npm run build` is not a gate against a missing import. On 2026-09-10 an import was
 * removed from AuthProvider.jsx while two call sites still used the identifier, and a second
 * component was referenced in JSX with no import at all. Vite built both cleanly — an undefined
 * identifier is valid JavaScript right up until it is evaluated — so the only thing standing
 * between that and a white screen in production was noticing by eye. Twice in one session that
 * nearly did not happen.
 *
 * This config is deliberately not a style pass. Turning on a full preset here would surface
 * hundreds of pre-existing findings in one commit, everyone would learn to ignore the output,
 * and the one rule that would have caught a real outage would be lost in it. If more rules are
 * wanted later, add them one at a time with the backlog cleared first.
 */
export default [
  {
    files: ['src/**/*.js', 'src/**/*.jsx'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        // Vite's automatic JSX runtime means React is not a required global, but the build
        // constants below are injected at compile time and are otherwise undefined.
        __APP_VERSION__: 'readonly',
      },
    },
    // noInlineConfig: existing files carry `// eslint-disable-line react-hooks/exhaustive-deps`
    // comments for a plugin this config does not load, which eslint reports as a hard error
    // ("Definition for rule ... was not found"). Ignoring inline config sidesteps that without
    // installing a plugin whose rules we are not ready to enforce — and it has a second benefit:
    // no-undef cannot be switched off from inside a file. A gate you can disable in the file it
    // guards is not a gate.
    linterOptions: { noInlineConfig: true },
    rules: {
      'no-undef': 'error',
    },
  },
  {
    files: ['test/**/*.js', 'test/**/*.jsx'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    linterOptions: { noInlineConfig: true },
    rules: { 'no-undef': 'error' },
  },
]
