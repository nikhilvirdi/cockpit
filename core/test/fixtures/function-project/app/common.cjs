const common = require('../lib/common.cjs');
function runCjs() { return common.work() + common.direct(); }
module.exports = { runCjs };
function Legacy() {}
function* generator() {}
function constructLegacy() { return new Legacy(); }
function invalidConstruct() { return new generator(); }
