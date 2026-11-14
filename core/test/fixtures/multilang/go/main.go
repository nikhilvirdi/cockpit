package main

import alias "example.com/cockpit-fixture/lib"

func Run() int { return alias.Leaf() + alias.Leaf() }
func Recur(n int) int {
	if n == 0 { return 0 }
	return Recur(n - 1)
}
type Runner interface { Work() int }
func Dynamic(r Runner) int { return r.Work() }
func Concrete() int { return (alias.Worker{}).Work() }
func main() {}
