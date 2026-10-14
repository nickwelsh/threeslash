/** @type {import('stylelint').Config} */
const config = {
    extends: ['stylelint-config-standard'],
    ignoreFiles: ['dist/**', '.agents/**', '.pnpm-store/**', 'node_modules/**', 'coverage/**', '.idea/**'],
};

export default config;
