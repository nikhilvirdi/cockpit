extern "C" {
#include "leaf.h"
}
namespace fixture {
int fn(int n) { return leaf(n); }
double fn(double n) { return n; }
template<class T> T passthrough(T n) { return n; }
int run() { return fn(2) + passthrough(3); }

struct Base {
    virtual int method() { return 1; }
};
int dispatch(Base& value) { return value.method(); }

struct Value final {
    int method() { return 1; }
};
int concrete(Value& value) { return value.method(); }

struct Constructed {
    explicit Constructed(int n) { leaf(n); }
};
Constructed* construct() { return new Constructed(2); }
int direct() { Constructed value(2); int scalar(0); return scalar; }
int qualified();
}
int fixture::qualified() { return fn(2); }
int callQualified() { return fixture::qualified(); }
