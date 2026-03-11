// Bundle entry point: core-js-pure URL + URLSearchParams polyfill
// These are pure JS implementations of the WHATWG URL Standard.
globalThis.URL = require("core-js-pure/actual/url");
globalThis.URLSearchParams = require("core-js-pure/actual/url-search-params");
