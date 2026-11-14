package app;
import other.Base;

final class Runner extends Base {
    static int leaf(int n) { return n; }
    static String leaf(String n) { return n; }
    Runner() { super(); }
    int run() { return leaf(3) + inherited(); }
    String text() { return leaf("hello"); }
    Runner create() { return new Runner(); }
    int dispatch(Base value) { return value.dynamic(); }
}
