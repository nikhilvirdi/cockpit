package lib
func Leaf() int { return 3 }
type Worker struct {}
func (Worker) Work() int { return Leaf() }
