#include "leaf.h"
int leaf(int n) { return n ? leaf(n - 1) : 0; }
int indirect(int (*callback)(int)) { return callback(0); }
