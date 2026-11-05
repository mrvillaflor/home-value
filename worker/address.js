/*
 * Re-export the shared normalizer. It lives in api/ so the Render
 * service, whose root is api/, and the page can use the same cache key.
 */

module.exports = require("../api/address");
