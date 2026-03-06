def slugify(value: str) -> str:
    return value.strip().lower().replace(" ", "-")


class Greeter:
    def greet(self, name: str) -> str:
        return self.format(name)

    def format(self, name: str) -> str:
        return slugify(name)
