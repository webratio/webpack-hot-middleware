module.exports = webpackHotMiddleware;

var helpers = require('./helpers');
var pathMatch = helpers.pathMatch;

function webpackHotMiddleware(compiler, opts) {
  opts = opts || {};
  opts.log =
    typeof opts.log == 'undefined' ? console.log.bind(console) : opts.log;
  opts.path = opts.path || '/__webpack_hmr';
  opts.heartbeat = opts.heartbeat || 10 * 1000;
  opts.clientEventsPath = opts.clientEventsPath || '/__webpack_hmr_client_events';

  var eventStream = createEventStream(opts.heartbeat);
  var latestStats = null;
  var closed = false;
  var clientEventsHandler = createClientEventsHandler(opts.onReloadNeeded);

  if (compiler.hooks) {
    compiler.hooks.invalid.tap('@wrtools/webpack-hot-middleware', onInvalid);
    compiler.hooks.done.tap('@wrtools/webpack-hot-middleware', onDone);
  } else {
    compiler.plugin('invalid', onInvalid);
    compiler.plugin('done', onDone);
  }
  function onInvalid() {
    if (closed) return;
    latestStats = null;
    if (opts.log) opts.log('webpack building...');
    eventStream.publish({ action: 'building' });
  }
  function onDone(statsResult) {
    if (closed) return;
    // Keep hold of latest stats so they can be propagated to new clients
    latestStats = statsResult;
    publishStats('built', latestStats, eventStream, opts.log);
  }
  var middleware = function(req, res, next) {
    if (closed) return next();
    if (pathMatch(req.url, opts.path)) {
      eventStream.handler(req, res);
      if (latestStats) {
        // Explicitly not passing in `log` fn as we don't want to log again on
        // the server
        publishStats('sync', latestStats, eventStream);
      }
    } else if (pathMatch(req.url, opts.clientEventsPath) && req.method === 'POST') {
      clientEventsHandler.handle(req, res);
    }
    return next();
  };
  middleware.publish = function(payload) {
    if (closed) return;
    eventStream.publish(payload);
  };
  middleware.close = function() {
    if (closed) return;
    // Can't remove compiler plugins, so we just set a flag and noop if closed
    // https://github.com/webpack/tapable/issues/32#issuecomment-350644466
    closed = true;
    eventStream.close();
    eventStream = null;
  };
  return middleware;
}

function createEventStream(heartbeat) {
  var clientId = 0;
  var clients = {};
  function everyClient(fn) {
    Object.keys(clients).forEach(function(id) {
      fn(clients[id]);
    });
  }
  var interval = setInterval(function heartbeatTick() {
    everyClient(function(client) {
      client.write('data: \uD83D\uDC93\n\n');
    });
  }, heartbeat).unref();
  return {
    close: function() {
      clearInterval(interval);
      everyClient(function(client) {
        if (!client.finished) client.end();
      });
      clients = {};
    },
    handler: function(req, res) {
      var headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/event-stream;charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        // While behind nginx, event stream should not be buffered:
        // http://nginx.org/docs/http/ngx_http_proxy_module.html#proxy_buffering
        'X-Accel-Buffering': 'no',
      };

      var isHttp1 = !(parseInt(req.httpVersion) >= 2);
      if (isHttp1) {
        req.socket.setKeepAlive(true);
        Object.assign(headers, {
          Connection: 'keep-alive',
        });
      }

      res.writeHead(200, headers);
      res.write('\n');
      var id = clientId++;
      clients[id] = res;
      req.on('close', function() {
        if (!res.finished) res.end();
        delete clients[id];
      });
    },
    publish: function(payload) {
      everyClient(function(client) {
        client.write('data: ' + JSON.stringify(payload) + '\n\n');
      });
    },
  };
}

function publishStats(action, statsResult, eventStream, log) {
  var statsOptions = {
    all: false,
    cached: true,
    children: true,
    modules: true,
    timings: true,
    hash: true,
    errors: true,
    warnings: true,
  };

  var bundles = [];

  // multi-compiler stats have stats for each child compiler
  // see https://github.com/webpack/webpack/blob/main/lib/MultiCompiler.js#L97
  if (statsResult.stats) {
    var processed = statsResult.stats.map(function(stats) {
      return extractBundles(normalizeStats(stats, statsOptions));
    });

    bundles = processed.flat();
  } else {
    bundles = extractBundles(normalizeStats(statsResult, statsOptions));
  }

  bundles.forEach(function(stats) {
    var name = stats.name || '';

    // Fallback to compilation name in case of 1 bundle (if it exists)
    if (!name && stats.compilation) {
      name = stats.compilation.name || '';
    }

    if (log) {
      log(
        'webpack built ' +
        (name ? name + ' ' : '') +
        stats.hash +
        ' in ' +
        stats.time +
        'ms'
      );
    }

    eventStream.publish({
      name: name,
      action: action,
      time: stats.time,
      hash: stats.hash,
      warnings: formatErrors(stats.warnings || []),
      errors: formatErrors(stats.errors || []),
      modules: buildModuleMap(stats.modules),
    });
  });
}

function formatErrors(errors) {
  if (!errors || !errors.length) {
    return [];
  }

  if (typeof errors[0] === 'string') {
    return errors;
  }

  // Convert webpack@5 error info into a backwards-compatible flat string
  return errors.map(function(error) {
    return error.moduleName + ' ' + error.loc + '\n' + error.message;
  });
}

function normalizeStats(stats, statsOptions) {
  var statsJson = stats.toJson(statsOptions);

  if (stats.compilation) {
    // webpack 5 has the compilation property directly on stats object
    Object.assign(statsJson, {
      compilation: stats.compilation,
    });
  }

  return statsJson;
}

function extractBundles(stats) {
  // Stats has modules, single bundle
  if (stats.modules) return [stats];

  // Stats has children, multiple bundles
  if (stats.children && stats.children.length) return stats.children;

  // Not sure, assume single
  return [stats];
}

function buildModuleMap(modules) {
  var map = {};
  modules.forEach(function(module) {
    map[module.id] = module.name;
  });
  return map;
}

function createClientEventsHandler(onReloadNeededCb) {
  function sendResponse(res) {
    var headers = {
      'Access-Control-Allow-Origin': '*',
    };
    res.writeHead(200, headers);
    res.write('\n');
    res.send();
    res.end();
  }
  function sendErrorResponse(res, status, error) {
    var headers = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    };
    res.writeHead(status, headers);
    res.write('\n');
    res.send(JSON.stringify({ error }));
    res.end();
  }
  return {
    handle: function(req, res) {
      var body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        try {
          var data = JSON.parse(body);
          if (data.event === 'ReloadNeeded') {
            sendResponse(res);
            if (onReloadNeededCb) {
              onReloadNeededCb();
            }
          } else {
            sendErrorResponse(res, 400, "Bad request: invalid event data");
          }
        } catch (err) {
          sendErrorResponse(res, 400, "Bad request: body is not a valid json");
        }
      });
    }
  }
}
