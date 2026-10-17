# Third-party source

`hongguo.cjs` is an unmodified copy of `spider/js/红果果[短].js` from
https://github.com/woshishiq1/drpys/tree/22261adfa31435e3b3ef5a730b8a2a75bcaf1715
(retrieved via the N3urda/hongguoTV vendored copy, 2026-10-17).
Upstream license: GPL-3.0; see LICENSE.drpys in this directory.
The source is loaded only by the local Node service (`server.js`) via a sandboxed
factory; it is not bundled into or served to the frontend.

Everything else in this project (server adapter, web frontend) is original code
written for personal local use and shares the same GPL-3.0 license to remain
compatible with the vendored source.
