#!/usr/bin/env python
# @license
# Copyright 2017 Google Inc.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
Simple web server serving seg-test chunked graph.

This can be used to develop & test the chunked graph functionality.
"""

from __future__ import print_function, absolute_import

import argparse
import os
import sys
from random import randint

try:
    # Python3 and Python2 with future package.
    from http.server import SimpleHTTPRequestHandler, HTTPServer
except ImportError:
    from BaseHTTPServer import HTTPServer
    from SimpleHTTPServer import SimpleHTTPRequestHandler


class RequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        SimpleHTTPRequestHandler.end_headers(self)

    def do_GET(self):
        print(self.path)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        s = '{"root":10}'
        self.wfile.write(s)

    # def do_OPTIONS(self):
    #     print(self.path)
    #     self.send_response(200)
    #     self.send_header('Content-Type', 'application/json')
    #     self.end_headers()
    #     src_node = randint(1,10)
    #     dst_node = randint(10,20)
    #     s = '{"edges":[{"w":0.5,"src":{0},"dst":{1}}]}'.format(src_node, dst_node)
    #     self.wfile.write(s)

class Server(HTTPServer):
    protocol_version = 'HTTP/1.1'

    def __init__(self, server_address):
        HTTPServer.__init__(self, server_address, RequestHandler)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('-p', '--port', default=8999, help='TCP port to listen on')
    ap.add_argument('-a', '--bind', default='127.0.0.1', help='Bind address')
    ap.add_argument('-d', '--directory', default='.', help='Directory to serve')

    args = ap.parse_args()
    os.chdir(args.directory)
    server = Server((args.bind, args.port))
    sa = server.socket.getsockname()
    print("Serving graph server test %s at http://%s:%d" % (os.getcwd(), sa[0], sa[1]))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
        sys.exit(0)
