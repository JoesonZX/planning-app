#!/usr/bin/env python3
"""开发服务器：SimpleHTTPRequestHandler + Cache-Control: no-cache。

默认 http.server 只发 Last-Modified，Chrome 启发式缓存（10% 规则）会在文件
修改后的几分钟内继续供旧响应——v9 冒烟时造成「改了代码页面不变」的连环误诊。
no-cache 强制每次 revalidation（未变 304，变了 200），开发期永不陈旧。
用法：python tools/devserver.py [port]（默认 8777）
"""

import functools
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    handler = functools.partial(NoCacheHandler, directory='.')
    with http.server.ThreadingHTTPServer(('127.0.0.1', port), handler) as srv:
        print(f'[ok] dev server on http://127.0.0.1:{port}/ (Cache-Control: no-cache)')
        srv.serve_forever()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
