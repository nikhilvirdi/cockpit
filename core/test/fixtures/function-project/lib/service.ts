export function leaf() { return 1; }
export function step() { return leaf(); }
export default function () { return step(); }
export const unused = () => 0;
export const callback = () => 0;
export const referenced = () => 0;
export function same() { return 10; }
export function overloaded(value: string): string;
export function overloaded(value: number): number;
export function overloaded(value: string | number) { return value; }
