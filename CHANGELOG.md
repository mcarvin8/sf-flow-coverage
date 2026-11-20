# Changelog

## [0.4.2](https://github.com/mcarvin8/sf-flow-coverage/compare/v0.4.1...v0.4.2) (2026-11-20)


### Bug Fixes

* **scaffold:** generate tests that pass in more real orgs ([#23](https://github.com/mcarvin8/sf-flow-coverage/issues/23)) ([04b114f](https://github.com/mcarvin8/sf-flow-coverage/commit/04b114f6930174166a22bb1118f36b0fd7411fbd))

## [0.4.1](https://github.com/mcarvin8/sf-flow-coverage/compare/v0.4.0...v0.4.1) (2026-11-20)


### Bug Fixes

* **scaffold:** never assign fields a test can't write ([#21](https://github.com/mcarvin8/sf-flow-coverage/issues/21)) ([1cb7087](https://github.com/mcarvin8/sf-flow-coverage/commit/1cb70876381e0f513856b12b0085489468a1dbf2))

## [0.4.0](https://github.com/mcarvin8/sf-flow-coverage/compare/v0.3.0...v0.4.0) (2026-11-20)


### Features

* list the Flow elements no test runs ([#14](https://github.com/mcarvin8/sf-flow-coverage/issues/14)) ([83fc31e](https://github.com/mcarvin8/sf-flow-coverage/commit/83fc31e48735ed4caebc60d992259adc0bd34eaf))
* point Process Builder processes toward migration ([#17](https://github.com/mcarvin8/sf-flow-coverage/issues/17)) ([7fab878](https://github.com/mcarvin8/sf-flow-coverage/commit/7fab8789d040de2bcb2aa2db23cee2d4390e5ee9))
* **readiness:** report the deploy-as-active setting ([#19](https://github.com/mcarvin8/sf-flow-coverage/issues/19)) ([998079e](https://github.com/mcarvin8/sf-flow-coverage/commit/998079e8cec269c50990804c64d8c1efef5facfd))
* **scaffold:** one condition engine for criteria, parents, and assertions ([#20](https://github.com/mcarvin8/sf-flow-coverage/issues/20)) ([20aa739](https://github.com/mcarvin8/sf-flow-coverage/commit/20aa739984ae13346a107e1c05b0c1c0cddc3ee7))
* **transform:** write Flow coverage as SonarQube, Cobertura, and lcov ([#16](https://github.com/mcarvin8/sf-flow-coverage/issues/16)) ([a7537fa](https://github.com/mcarvin8/sf-flow-coverage/commit/a7537fa979068a8079b42c57d665ed12f0c06eda))
* warn when the org has no Flow coverage at all ([#18](https://github.com/mcarvin8/sf-flow-coverage/issues/18)) ([ae438cc](https://github.com/mcarvin8/sf-flow-coverage/commit/ae438cce382bd1200505c06e21adc4dfcc4f94ae))

## [0.3.0](https://github.com/mcarvin8/sf-flow-coverage/compare/v0.2.0...v0.3.0) (2026-11-20)


### Features

* **gate:** compare changed Flows with the org version via --content-check ([#9](https://github.com/mcarvin8/sf-flow-coverage/issues/9)) ([841c417](https://github.com/mcarvin8/sf-flow-coverage/commit/841c4170e361a0669727b851823ecfe4d00b9a0d))
* **gate:** fail Flows whose org version was likely deployed inactive ([#7](https://github.com/mcarvin8/sf-flow-coverage/issues/7)) ([5564801](https://github.com/mcarvin8/sf-flow-coverage/commit/55648016d9be109bdc853ef300d70d6c33bb117e))
* **scaffold:** assert what record-triggered Flows do ([#13](https://github.com/mcarvin8/sf-flow-coverage/issues/13)) ([9ef29b5](https://github.com/mcarvin8/sf-flow-coverage/commit/9ef29b5245b6f25d660005231b3e94907c32a2ed))
* **scaffold:** insert parent records for required and criteria lookups ([#12](https://github.com/mcarvin8/sf-flow-coverage/issues/12)) ([cc57296](https://github.com/mcarvin8/sf-flow-coverage/commit/cc57296d58439531b5f2f2963e2da02ddc158484))
* **scaffold:** meet comparison, string, and IsChanged entry criteria ([#10](https://github.com/mcarvin8/sf-flow-coverage/issues/10)) ([5451dbb](https://github.com/mcarvin8/sf-flow-coverage/commit/5451dbb66921d59ad00812ed18c060dfeb1c992e))
* **scaffold:** meet simple entry-criteria formulas ([#11](https://github.com/mcarvin8/sf-flow-coverage/issues/11)) ([1a5b8e4](https://github.com/mcarvin8/sf-flow-coverage/commit/1a5b8e4257462e51092077d9746dcc6ad3af1e9d))

## [0.2.0](https://github.com/mcarvin8/sf-flow-coverage/compare/v0.1.0...v0.2.0) (2026-11-20)


### Features

* read git history with tsgit instead of the git binary ([#5](https://github.com/mcarvin8/sf-flow-coverage/issues/5)) ([cb61d75](https://github.com/mcarvin8/sf-flow-coverage/commit/cb61d75f9e188b49b7c4e1119bc55fff53db76a7))
* **scaffold:** fill fields for IsNull false entry criteria ([#3](https://github.com/mcarvin8/sf-flow-coverage/issues/3)) ([bac20b4](https://github.com/mcarvin8/sf-flow-coverage/commit/bac20b467760b1ca4b8b1ecb99cc675c4019cda1))

## [0.1.0](https://github.com/mcarvin8/sf-flow-coverage/compare/v0.0.1...v0.1.0) (2026-11-20)


### Features

* add flowcov readiness, gate and scaffold commands ([8346263](https://github.com/mcarvin8/sf-flow-coverage/commit/83462635c6a741dfc8091600e5de73c1caafc81a))
