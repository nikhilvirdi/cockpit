import run, { forwarded as imported, unused, same, callback, overloaded, referenced } from '@workspace/index';
import type { leaf as TypeLeaf } from '../lib/service';
import * as service from '../lib/service';
type Deferred = typeof TypeLeaf;
const alias = imported;
const arrow = () => alias();
const expr = function named() { return arrow(); };
const unnamed = function () { return expr(); };
const tools = { work() { return unnamed(); }, arrow: () => service.leaf() };
function register(_cb: () => number) {}
function execute(cb: () => number) { return cb(); }
export function recurse(n: number): number { return n ? recurse(n - 1) : 0; }
export function entry() {
  const reference = referenced;
  const same = () => 20;
  function nested() { return same(); }
  register(callback);
  return run() + service['leaf']() + alias?.() + tools.work() + tools.arrow() + nested()
    + overloaded(1) + overloaded('x').length + recurse(1) + execute(reference) + (() => service.leaf())();
}
export function importedSame() { return same(); }
export function indirect(choose: boolean) {
  const selected = choose ? service.step : service.leaf;
  return selected();
}
export function dynamically(key: keyof typeof tools) { return tools[key](); }
export function builtin() { return Math.max(1, 2); }
import { missing } from './missing';
export function missingCall() { return missing(); }
export function invalid() { return overloaded(true); }
function reassigned() { return 0; }
reassigned = () => 1;
export function changed() { return reassigned(); }
export function shadowed(require: (path: string) => () => number) {
  return require('../lib/service')();
}
service.leaf();
const wrapped = (() => alias()) as () => number;
export function wrappedCall() { return wrapped(); }
import * as barrel from '../lib';
export function typeOnlyMember() { return barrel.TypeOnlyMember(); }
export async function dynamicImport() { return import('../lib/service'); }
