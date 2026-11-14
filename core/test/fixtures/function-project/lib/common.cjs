function leaf() { return 3; }
module.exports = { work: function () { return leaf(); } };
module.exports.direct = () => leaf();
