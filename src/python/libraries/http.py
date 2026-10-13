# Reading URLs with urllib, requests and pandas: pyodide-http's patches,
# with PLL's own transport under them. Run after the `pyodide-http`
# package is loaded, each time a program imports a module that reads URLs,
# so `requests` is patched once it is there too; every step is idempotent.
#
# What PLL's transport changes: the bytes arrive as they were sent, as an
# `arraybuffer` (pyodide-http decodes a string as ISO-8859-15 outside a
# browser's worker, which is not the Latin-1 the desktop's XHR gives, and
# eight byte values came back wrong); a timeout is honoured wherever it is
# given; a Stop ends the wait on the desktop; and a request that fails is
# urllib's `URLError` or requests' `ConnectionError`, as in CPython, with
# what went wrong. `urlopen` raises `HTTPError` for an answer of 400 and
# above, as CPython's does, so pandas does not read an error page as data.

import email.parser as _pll_http_email
import http.client as _pll_http_client
import io as _pll_http_io
import socket as _pll_http_socket
import urllib.error as _pll_http_error
import urllib.request as _pll_http_request

import pyodide_http as _pll_ph
import pyodide_http._core as _pll_ph_core
import pyodide_http._urllib as _pll_ph_urllib


def _pll_http_send(request, stream=False):
    """pyodide-http's `send`, as PLL makes every request."""
    from js import URLSearchParams, XMLHttpRequest
    from pyodide.ffi import JsException, to_js

    url = request.url
    if request.params:
        params = URLSearchParams.new()
        for key, value in request.params.items():
            params.append(key, value)
        url += "?" + params.toString()
    xhr = XMLHttpRequest.new()
    xhr.open(request.method, url, False)
    xhr.responseType = "arraybuffer"
    if request.timeout:
        xhr.timeout = max(1, int(request.timeout * 1000))
    view = globals().get("_pll_interrupt_view")
    if view is not None and getattr(XMLHttpRequest, "pllNode", False):
        xhr.pllInterrupt = view
    for name, value in request.headers.items():
        if name.lower() not in _pll_ph_core.HEADERS_TO_IGNORE:
            xhr.setRequestHeader(name, value)
    failure = None
    try:
        xhr.send(to_js(request.body))
    except JsException as e:
        failure = (getattr(e, "name", ""), str(getattr(e, "message", "") or e))
    if failure is not None:
        kind, message = failure
        if kind == "AbortError":
            # A Stop, taken now rather than at the next bytecode check - and
            # outside the `except`, so it is not raised from the JavaScript
            # error, whose place is in PLL's worker.
            view[0] = 0
            _pll_on_sigint(2, None)
        if kind == "TimeoutError":
            raise _pll_ph_core._StreamingTimeout(message or "timed out", request=request)
        raise _pll_ph_core._StreamingError(message or "could not connect", request=request)
    headers = dict(_pll_http_email.Parser().parsestr(xhr.getAllResponseHeaders()))
    response = xhr.response
    body = bytes(response.to_bytes()) if response is not None else b""
    return _pll_ph_core.Response(status_code=xhr.status, headers=headers, body=body)


def _pll_urlopen(url, data=None, timeout=_pll_http_socket._GLOBAL_DEFAULT_TIMEOUT, *, context=None):
    """`urllib.request.urlopen`, as CPython's behaves, over PLL's transport."""
    method = "POST" if data is not None else "GET"
    headers = {}
    if isinstance(url, _pll_http_request.Request):
        if data is None:
            data = url.data
        method = url.get_method()
        headers = dict(url.header_items())
        url = url.full_url
    request = _pll_ph_core.Request(method, url, headers=headers, body=data)
    if isinstance(timeout, (int, float)) and not isinstance(timeout, bool):
        request.timeout = timeout
    try:
        answer = _pll_http_send(request)
    except _pll_ph_core._StreamingTimeout as e:
        raise _pll_http_error.URLError(TimeoutError(e.message)) from None
    except _pll_ph_core._StreamingError as e:
        raise _pll_http_error.URLError(e.message) from None
    # A response read from bytes, as pyodide-http builds one. Without its
    # length: when the body was compressed, that is the compressed length.
    lines = [b"HTTP/1.1 %d %s" % (answer.status_code, _pll_http_client.responses.get(answer.status_code, "").encode("ascii"))]
    for key, value in answer.headers.items():
        if key.lower() != "content-length":
            lines.append(("%s: %s" % (key, value)).encode("latin-1", "replace"))
    response = _pll_http_client.HTTPResponse(_pll_ph_urllib.FakeSock(b"\r\n".join(lines) + b"\r\n\r\n" + answer.body))
    response.begin()
    response.url = url
    if answer.status_code >= 400:
        raise _pll_http_error.HTTPError(url, answer.status_code, response.reason, response.headers, response)
    return response


def _pll_opener_open(self, fullurl, data=None, timeout=_pll_http_socket._GLOBAL_DEFAULT_TIMEOUT):
    return _pll_urlopen(fullurl, data, timeout)


def _pll_patch_http():
    _pll_ph.patch_all()
    _pll_ph_core.send = _pll_http_send
    _pll_ph_urllib.send = _pll_http_send
    _pll_http_request.urlopen = _pll_urlopen
    _pll_http_request.OpenerDirector.open = _pll_opener_open
    try:
        import pyodide_http._requests as _pll_ph_requests
        import requests as _pll_requests
    except ImportError:
        return
    _pll_ph_requests.send = _pll_http_send
    adapter = _pll_ph_requests.PyodideHTTPAdapter
    if getattr(adapter.send, "_pll", False):
        return
    original = adapter.send

    def send(self, request, **kwargs):
        # pyodide-http raises requests' error with no message; the one it
        # was raised from says what happened.
        try:
            return original(self, request, **kwargs)
        except _pll_requests.ConnectionError as e:
            cause = e.__context__
            if not e.args and isinstance(cause, _pll_ph_core._RequestError):
                raise type(e)(cause.message, request=request) from None
            raise

    send._pll = True
    adapter.send = send


_pll_patch_http()
