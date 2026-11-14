#include "leaf.h"
static int twice(int n) { return leaf(n) + leaf(n); }
int run(int n) { return twice(n); }
