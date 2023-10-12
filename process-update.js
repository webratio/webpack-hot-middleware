/**
 * Based heavily on https://github.com/webpack/webpack/blob/main/hot/dev-server.js
 * Original copyright Tobias Koppers @sokra (MIT license)
 */

if (!module.hot) {
  throw new Error("[HMR] Hot Module Replacement is disabled.");
}

/*globals window __webpack_hash__ */
let lastHash;
function upToDate(hash) {
  if (hash) lastHash = hash;
  return lastHash == __webpack_hash__;
}

module.exports = function(hash, moduleMap, options) {
  var reload = options.reload;
  if (!upToDate(hash) && module.hot.status() == "idle") {
    if (options.log) {
      console.log("[HMR] Checking for updates on the server...");
    }
    check();
  }

  function check() {
    module.hot
      .check(true)
      .then(function(updatedModules) {
        if (!updatedModules) {
          if (options.warn) {
            console.warn("[HMR] Cannot find update (Full reload needed)");
            console.warn("[HMR] (Probably because of restarting the server)");
          }
          performReload();
          return;
        }

        if (!upToDate()) {
          check();
        }

        logUpdates(updatedModules, renewedModules);
      })
      .catch(function(err) {
        var status = module.hot.status();
        if (["abort", "fail"].indexOf(status) >= 0) {
          if (options.warn) {
            console.warn("[HMR] Cannot apply update.  (Full reload needed)");
            console.warn("[HMR] " + (err.stack || err.message));
          }
          performReload();
        } else if (options.warn) {
          console.warn("[HMR] Update check failed: " + (err.stack || err.message));
        }
      });
  };

  function logUpdates(updatedModules, renewedModules) {
    var unacceptedModules = updatedModules.filter(function(moduleId) {
      return renewedModules && renewedModules.indexOf(moduleId) < 0;
    });

    if (unacceptedModules.length > 0) {
      if (options.warn) {
        console.warn("[HMR] The following modules couldn't be hot updated: (They would need a full reload!)");
        unacceptedModules.forEach(function(moduleId) {
          console.warn("[HMR]  - " + (moduleMap[moduleId] || moduleId));
        });
      }
      performReload();
      return;
    }

    if (options.log) {
      if (!renewedModules || renewedModules.length === 0) {
        console.log("[HMR] Nothing hot updated.");
      } else {
        console.log("[HMR] Updated modules:");
        renewedModules.forEach(function(moduleId) {
          console.log("[HMR]  - " + (moduleMap[moduleId] || moduleId));
        });
      }

      if (upToDate()) {
        console.log("[HMR] App is up to date.");
      }
    }
  }

  function performReload() {
    if (reload) {
      if (options.warn) {
        console.warn("[HMR] Reloading page");
      }
      window.location.reload();
    }
  }
};
