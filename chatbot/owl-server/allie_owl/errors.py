class OwlError(Exception):
    def __init__(self, message: str, status_code: int = 500, code: str = "server_error", param: str | None = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.param = param


class DownstreamError(OwlError):
    pass

