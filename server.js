#!/usr/bin/env node
import pkg from "stremio-addon-sdk";
const { serveHTTP, publishToCentral } = pkg;

import addonInterface from "./addon.js";
import path from "path";

serveHTTP(addonInterface, {
  port: process.env.PORT || 3000,
  customConfigPage: path.join(process.cwd(), "static", "config.html"),
  static: "/static",
});

// When you've deployed your addon, un-comment this line:
// publishToCentral("https://my-addon.awesome/manifest.json")
// for more information on deploying, see: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/deploying/README.md
