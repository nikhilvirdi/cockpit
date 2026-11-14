#include "leaf.h"
#ifndef COCKPIT_FIXTURE
#error compile database flag was not applied
#endif
static int twice(int n) { return leaf(n) + leaf(n); }
int run(int n) { return twice(n); }
