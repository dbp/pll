# Reading URLs with urllib, requests and pandas, through the host's network
# (`_pll_http_request`): Pyodide's Python has no sockets of its own. Run each
# time a program imports a module that reads URLs, so `requests` is set up
# once it is there too; every step is idempotent.
#
# A request that fails is urllib's `URLError` or requests' `ConnectionError`,
# as in CPython, with what went wrong. `urlopen` raises `HTTPError` for an
# answer of 400 and above, as CPython's does, so pandas does not read an
# error page as data.

import http.client as _pll_http_client
import io as _pll_http_io
import socket as _pll_http_socket
import urllib.error as _pll_http_error
import urllib.request as _pll_http_urllib


class _PllAnswerBytes:
    """What `http.client.HTTPResponse` reads an answer from, as from a socket."""

    def __init__(self, data):
        self._data = data

    def makefile(self, mode):
        return _pll_http_io.BytesIO(self._data)


def _pll_urlopen(url, data=None, timeout=_pll_http_socket._GLOBAL_DEFAULT_TIMEOUT, *, context=None):
    """`urllib.request.urlopen`, as CPython's behaves, over the host's network."""
    method = "POST" if data is not None else "GET"
    headers = {}
    if isinstance(url, _pll_http_urllib.Request):
        if data is None:
            data = url.data
        method = url.get_method()
        headers = dict(url.header_items())
        url = url.full_url
    seconds = timeout if isinstance(timeout, (int, float)) and not isinstance(timeout, bool) else None
    try:
        status, answer_headers, body = _pll_http_request(method, url, headers, data, seconds)
    except TimeoutError as e:
        raise _pll_http_error.URLError(e) from None
    except OSError as e:
        raise _pll_http_error.URLError(str(e)) from None
    head = [b"HTTP/1.1 %d %s" % (status, _pll_http_client.responses.get(status, "").encode("ascii"))]
    head += [("%s: %s" % item).encode("latin-1", "replace") for item in answer_headers.items()]
    response = _pll_http_client.HTTPResponse(_PllAnswerBytes(b"\r\n".join(head) + b"\r\n\r\n" + body))
    response.begin()
    response.url = url
    if status >= 400:
        raise _pll_http_error.HTTPError(url, status, response.reason, response.headers, response)
    return response


def _pll_opener_open(self, fullurl, data=None, timeout=_pll_http_socket._GLOBAL_DEFAULT_TIMEOUT):
    return _pll_urlopen(fullurl, data, timeout)


def _pll_patch_requests():
    """Every `requests` session sends through the host's network."""
    try:
        import requests as _pll_requests
        from requests.adapters import BaseAdapter
    except ImportError:
        return
    if getattr(_pll_requests.Session, "_pll", False):
        return

    class _PllAdapter(BaseAdapter):
        def send(self, request, stream=False, timeout=None, **kwargs):
            if isinstance(timeout, tuple):
                # (connect, read): one wait here, for both.
                timeout = sum(t or 0 for t in timeout) or None
            try:
                status, headers, body = _pll_http_request(
                    request.method, request.url, dict(request.headers), request.body, timeout
                )
            except TimeoutError as e:
                raise _pll_requests.ConnectTimeout(str(e), request=request) from None
            except OSError as e:
                raise _pll_requests.ConnectionError(str(e), request=request) from None
            response = _pll_requests.Response()
            response.status_code = status
            response.headers = _pll_requests.structures.CaseInsensitiveDict(headers)
            response.encoding = _pll_requests.utils.get_encoding_from_headers(response.headers)
            response.raw = _pll_http_io.BytesIO(body)
            response.reason = _pll_http_client.responses.get(status, "")
            response.url = request.url
            response.request = request
            return response

        def close(self):
            pass

    started = _pll_requests.Session.__init__

    def __init__(self, *args, **kwargs):
        started(self, *args, **kwargs)
        self.mount("https://", _PllAdapter())
        self.mount("http://", _PllAdapter())

    _pll_requests.Session.__init__ = __init__
    _pll_requests.Session._pll = True


_pll_http_urllib.urlopen = _pll_urlopen
_pll_http_urllib.OpenerDirector.open = _pll_opener_open
_pll_patch_requests()
