function leaf() { return 1; }
class Base {
  constructor() { leaf(); }
  work(value: number): number;
  work(value: string): number;
  work(value: number | string) { return typeof value === 'number' ? value : value.length; }
  static shared() { return leaf(); }
}
class Child extends Base {
  constructor() { super(); }
  #privateWork() { return leaf(); }
  field = () => leaf();
  own() { return this.#privateWork() + super.work(1) + this.work('x'); }
}
class Override extends Base {
  work() { return 2; }
}
export function runClasses() {
  const exact: Base = new Child();
  const child = new Child();
  return exact.work(1) + child.own() + child.field() + Child.shared() + new Base().work('x');
}
export function dispatch(value: Base | Override) { return value.work(1); }
export function broad(value: Base) { return value.work('x'); }
class Other extends Base {}
export function inheritedImplicit() { return new Other().work(1); }

export function optionalMethod() { return (new Child()).own?.(); }
class Mutable {
  work = () => 0;
  other = () => 1;
}
export function modify(receiver: Mutable, key: 'work' | 'other') { receiver[key] = () => 0; }
export function changedMember() { return new Mutable().work(); }
class ReturnsReplacement {
  constructor() { return { work() { return 3; } }; }
  work() { return 2; }
}
export function replacingConstructor() { return new ReturnsReplacement().work(); }
function replaceMethod(_value: unknown, _context: unknown) { return () => 0; }
class Decorated {
  @replaceMethod
  static work() { return 1; }
}
export function decoratedMethod() { return Decorated.work(); }
