class TransportError(Exception):
    pass


class IncompleteRead(TransportError):
    def __init__(self, partial: int, expected: int | None = None):
        self.partial = partial
        self.expected = expected


MAX_REDIRECTS = 10
