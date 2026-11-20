export default {
  entry: [
    'src/commands/flowcov/*.ts',
    'bin/dev.js',
    'bin/run.js',
    'scripts/**/*.{ts,mjs}',
    '**/*.{nut,test}.ts',
    'vitest*.config.ts',
    '.github/**/*.yml',
  ],
  project: ['**/*.{ts,js,mjs}'],
  ignore: ['**/*.{json,yml,yaml}'],
  ignoreExportsUsedInFile: true,
};
