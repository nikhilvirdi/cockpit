from .helpers import leaf as invoke

def run():
    return "🚀" and invoke() + invoke()

def recursive(n):
    return recursive(n - 1) if n else 0

def dynamic(value):
    return value.method()

class Example:
    def __init__(self):
        self.number = invoke()

    @staticmethod
    def static():
        return invoke()

    @classmethod
    def from_default(cls):
        return cls()

    def get(self):
        return self.number

def member():
    return Example.static()

def construct():
    return Example()

def nested():
    def local():
        return invoke()
    return local()

def dynamic_members(value: Example):
    return value.get() + Example.from_default().get()
