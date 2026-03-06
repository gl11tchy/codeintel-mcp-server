from .util import Greeter, slugify


def make_slug(value: str) -> str:
    return slugify(value)


def greet_name(name: str) -> str:
    greeter = Greeter()
    return greeter.greet(name)
