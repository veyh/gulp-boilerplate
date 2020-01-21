const fs = require("fs");
const babel = require("gulp-babel");
const changed = require("gulp-changed");
const sass = require("gulp-sass");
const notify = require("gulp-notify");
const concat = require("gulp-concat");
const merge = require("merge-stream");
const path = require("path");

const _ = require("lodash");
const envify = require("envify/custom");
const watchify = require("watchify");
const browserify = require("browserify");
const source = require("vinyl-source-stream");
const buffer = require("vinyl-buffer");
const fancyLog = require("fancy-log");

const madge = require("madge");
const Promise = require("bluebird");
Promise.config({ longStackTraces: true });
const rimraf = Promise.promisify(require("rimraf"));

const DEFAULTS = {
  babelWithoutRegenerator: false,
  babelConfig: {
    presets: [
      "@babel/preset-env",
      "@babel/preset-react",
      "@babel/preset-flow",
    ],

    plugins: [
      // Stage 0
      "@babel/plugin-proposal-function-bind",

      // Stage 1
      "@babel/plugin-proposal-export-default-from",
      "@babel/plugin-proposal-export-namespace-from",
      "@babel/plugin-proposal-logical-assignment-operators",
      ["@babel/plugin-proposal-optional-chaining", { "loose": false }],
      ["@babel/plugin-proposal-pipeline-operator", {
        "proposal": "minimal",
      }],
      ["@babel/plugin-proposal-nullish-coalescing-operator", {
        "loose": false,
      }],
      "@babel/plugin-proposal-do-expressions",

      // Other
      "@babel/plugin-proposal-object-rest-spread",
      "@babel/plugin-proposal-class-properties",

      ["@babel/plugin-transform-async-to-generator", {
        "module": "bluebird",
        "method": "coroutine"
      }],

      "babel-plugin-transform-dirname-filename",
    ],
  },
  es5Dir: "es5",
  bundleDir: "dist",
  cleanDirs: [],
  cleanSrc: [], // passed to gulp.src()
  jsSrc: null, // passed to gulp.src()
  madgeSrc: null, // passed to gulp.src()

  // Some packages may intentionally self-reference, so you can provide a
  // function to ignore those.
  //
  // Will be called with each found circular dependency, eg.
  //   ["knex.js"] // a self-referencing module
  //   ["some/file.js"] // a self-referencing file
  madgeAllowCircular: _dependency => false,

  sassSrc: null, // passed to gulp.src()
  sassIncludePaths: [],

  // Whether to show tray notifications when stuff gets compiled.
  useNotify: true,

  browserifyOptions: {
    // entries: [],
    plugin: [],
  },

  // If true, browserifyOptions.entries will be treated in the following manner
  //
  //   ["some/file.js", "other/file.js"]
  //      "some/file.js" --> "dist/some/file.bundle.js"
  //      "other/file.js" --> "dist/other/file.bundle.js"
  //
  //   { "dst/bundle.js": "src/file.js" }
  //     "src/file.js" --> "dst/bundle.js"
  //
  //   { "dst/bundle.js": ["src/aaa.js", "src/bbb.js"] }
  //     "src/aaa.js" --> "dst/bundle.js"
  //     "src/bbb.js" --> "dst/bundle.js"
  //
  browserifyIntoMultipleFiles: false,

  // This is for when you need an additional config file as a bundle. It uses
  // CONFIG_ENV environment variable to add a suffix for it. Example
  //
  // browserifyEnvConfig: {
  //   src: env => "cfg" + env
  // }
  //
  // With no CONFIG_ENV, results in "cfg"
  // With CONFIG_ENV=test, results in "cfg.test"
  browserifyEnvConfig: {},

  // Additional environment variables passed into browserify, which will the be
  // replaced with their actual values in the bundle.
  //
  // Example
  //
  // browserifyEnv: {
  //   FOO: "bar",
  // }
  //
  // Every reference to process.env.FOO will be replaced with "bar".
  browserifyEnv: {},

  // Function that allows you to modify the preset sequences, for example add
  // new tasks.
  sequenceHook: (_taskName, seq) => seq,
};

function mergeWithDefaultOpts(opts) {
  return _.merge(DEFAULTS, opts);
}

const ENV = process.env.CONFIG_ENV && `.${process.env.CONFIG_ENV}` || "";

function setup(gulp, opts) {
  if (typeof opts === "function") {
    opts = opts(_.cloneDeep(DEFAULTS));
  }

  else {
    opts = mergeWithDefaultOpts(opts);
  }

  if (opts.babelWithoutRegenerator) {
    disableRegenerator(opts.babelConfig);
  }

  opts.babelConfig.presets =
    resolveBabelPackages(opts.babelConfig.presets);

  opts.babelConfig.plugins =
    resolveBabelPackages(opts.babelConfig.plugins);

  const usingBabel = opts.jsSrc && opts.babelConfig && opts.es5Dir;
  const madgeSrc = opts.madgeSrc || opts.jsSrc;
  const usingMadge = madgeSrc;
  const usingSass = opts.sassSrc && opts.bundleDir;
  const usingBrowserify = _.size(opts.browserifyOptions.entries) > 0 &&
    opts.bundleDir;
  const usingBrowserifyConfigEnv = usingBrowserify &&
    typeof opts.browserifyEnvConfig.src === "function";
  const usingWatch = usingBabel || usingSass || usingBrowserifyConfigEnv;

  const tasks = {};
  const lazyTasks = {};

  function addTask(name, task) {
    tasks[name] = task;
  }

  function addLazyTask(name, taskCreator) {
    lazyTasks[name] = taskCreator;
  }

  function registerTasks() {
    for (const taskName of Object.keys(tasks)) {
      const task = tasks[taskName];
      task.displayName = taskName;
      gulp.task(taskName, task);
    }

    for (const taskName of Object.keys(lazyTasks)) {
      const task = lazyTasks[taskName]();
      task.displayName = taskName;
      gulp.task(taskName, task);
    }
  }

  const getCommonTasks = () => [
    tasks.clean,
    usingBabel && tasks.babel,
    usingMadge && tasks.madge,
    usingSass && tasks.sass,
  ];

  addLazyTask("default", function () {
    const seq = [
      ...getCommonTasks(),
      usingBrowserifyConfigEnv && tasks["browserify-config"],
      usingBrowserify && tasks.watchify,
      usingWatch && tasks.watch
    ]
    .filter(x => !!x);

    return gulp.series(
      ...opts.sequenceHook("default", seq),
    );
  });

  addLazyTask("dev", function () {
    const seq = [
      ...getCommonTasks(),
      usingBrowserifyConfigEnv && tasks["browserify-config"],
      usingBrowserify && tasks.browserify,
    ]
    .filter(x => !!x);

    return gulp.series(
      ...opts.sequenceHook("dev", seq),
    );
  });

  addLazyTask("prod", function () {
    const seq = [
      ...getCommonTasks(),
      setDefaultEnvToProduction,
      usingBrowserifyConfigEnv && tasks["browserify-config"],
      usingBrowserify && tasks["browserify-prod"],
    ]
    .filter(x => !!x);

    return gulp.series(
      ...opts.sequenceHook("prod", seq)
    );
  });

  function setDefaultEnvToProduction(done) {
    process.env.NODE_ENV = process.env.NODE_ENV || "production";
    done();
  }

  function promiseFromVinylStream(stream) {
    return new Promise((resolve, reject) => {
      const files = [];
      stream.on("data", file => { files.push(file); });
      stream.on("end", () => resolve(files));
      stream.on("error", error => reject(error));
    });
  }

  addTask("clean", function () {
    return Promise.join(
      opts.cleanSrc.length && promiseFromVinylStream(gulp.src(opts.cleanSrc))
        .map(file => file.path),

      Promise.each(opts.cleanDirs, d => rimraf(d)),
    );
  });

  // NOTE: if using generators, check README
  // https://www.npmjs.com/package/gulp-babel
  usingBabel &&
  addTask("babel", function () {
    const babelStream = babel(opts.babelConfig);

    babelStream.on("error", err => {
      fancyLog("Babel Error", err);
      babelStream.end();
    });

    return gulp.src(opts.jsSrc, { sourcemaps: true })
      .pipe(changed(opts.es5Dir))
      .pipe(babelStream)
      .pipe(gulp.dest(opts.es5Dir, { sourcemaps: true }));
    // .pipe(notify("ES5 compiled."));
  });

  usingMadge && addTask("madge", function () {
    return promiseFromVinylStream(gulp.src(madgeSrc))
      .map(file => file.path)
      .then(madge)
      .then(res => {
        const deps = res
          .circular()
          .filter(dep =>
            !opts.madgeAllowCircular(dep)
          );

        if (deps.length > 0) {
          throw new Error(
            "circular dependencies: " +
            require("util").inspect(deps)
          );
        }

        // Ok.
      });
  });

  usingSass &&
  addTask("sass", function () {
    return gulp.src(opts.sassSrc, { sourcemaps: true })
      .pipe(sass({
        includePaths: opts.sassIncludePaths,
      })
      .on("error", sass.logError))
      .pipe(concat("bundle.css"))
      .pipe(gulp.dest(opts.bundleDir, { sourcemaps: true }));
    // .pipe(notify("CSS compiled."));
  });

  usingWatch &&
  addTask("watch", function () {
    usingBabel && gulp.watch(opts.jsSrc , gulp.parallel("babel", "madge"));
    usingSass && gulp.watch(opts.sassSrc, tasks.sass);
    usingBrowserifyConfigEnv &&
      gulp.watch(opts.browserifyEnvConfig.src(ENV), ["browserify-config"]);
  });

  usingBrowserifyConfigEnv &&
  addTask("browserify-config", function () {
    fs.writeFileSync(
      `${opts.bundleDir}/config.browserify.js`,
      fs.readFileSync(opts.browserifyEnvConfig.src(ENV))
    );
  });

  function mapBrowserifyDstSrcs(func) {
    return _.map(getBrowserifyDstSrcs(), func);
  }

  function getBrowserifyDstSrcs() {
    const entries = getBrowserifyEntries();

    if (opts.browserifyIntoMultipleFiles) {
      return entries;
    }

    return _.reduce(entries, (acc, srcs) => {
      const dst = path.normalize(`${opts.bundleDir}/bundle.js`);
      acc[dst] = [...(acc[dst] || []), ...srcs];
      return acc;
    }, {});
  }

  function getBrowserifyEntries() {
    const entries = opts.browserifyOptions.entries;

    if (!entries) {
      return {};
    }

    if (_.isArray(entries)) {
      return entries.reduce((acc, src) => {
        const dir = path.dirname(src);
        const ext = path.extname(src);
        const base = path.basename(src, ext);
        const dst = path.normalize(`dist/${dir}/${base}.bundle${ext}`);
        acc[dst] = [src];
        return acc;
      }, {});
    }

    return _.mapValues(
      entries,
      srcs => _.isArray(srcs) ? srcs : [srcs]
    );
  }

  usingBrowserify &&
  addTask("browserify", function () {
    return merge(mapBrowserifyDstSrcs((srcs, dst) => {
      const b = browserify({
        ...opts.browserifyOptions,
        entries: srcs,
        debug: true,
      });

      b.on("log", fancyLog);
      return bundle(b, dst);
    }));
  });

  usingBrowserify &&
  addTask("browserify-prod", function () {
    return merge(mapBrowserifyDstSrcs((srcs, dst) => {
      const b = browserify({
        ...opts.browserifyOptions,
        entries: srcs,
        debug: false,
      });

      b.on("log", fancyLog);
      return bundle(b, dst);
    }));
  });

  usingBrowserify &&
  addTask("watchify", function () {
    return merge(mapBrowserifyDstSrcs((srcs, dst) => {
      const b = browserify({
        cache: {},
        packageCache: {},
        ...opts.browserifyOptions,
        entries: srcs,
        plugin: [...opts.browserifyOptions.plugin, watchify],
      });

      b.on("log", fancyLog);
      b.on("update", function () {
        return bundle(b, dst);
      });

      return bundle(b, dst);
    }));
  });

  function bundle(b, dst) {
    b.transform(envify({
      _: "purge",
      CONFIG_ENV: process.env.CONFIG_ENV || "",
      NODE_ENV: process.env.NODE_ENV || "development",
      ...opts.browserifyEnv,
    }));

    const dstName = path.basename(dst);
    const dstDir = path.dirname(dst);

    return b.bundle()
      .on("error", (...args) => fancyLog("Browserify Error", ...args))
      .pipe(source(dstName))
      .pipe(buffer())
      .pipe(notify("Browserified."))
      // Add transformation tasks to the pipeline here.
      .pipe(gulp.dest(dstDir));
  }

  registerTasks();
}

function resolveBabelPackages(pkgs) {
  return pkgs
    .filter(x => !!x)
    .map(p => {
      if (typeof p === "string") {
        return require.resolve(p);
      }

      if (_.isArray(p)) {
        const [name, ...args] = p;
        return [require.resolve(name), ...args];
      }

      throw new Error("invalid type");
    });
}

function disableRegenerator(babelConfig) {
  babelConfig.presets = babelConfig.presets
    .map(p => {
      if (p === "@babel/preset-env") {
        return [p, {
          exclude: [
            "transform-regenerator",
            "transform-async-to-generator"
          ],
        }];
      }

      return p;
    });

  babelConfig.plugins = babelConfig.plugins
    .filter(p =>
      !(_.isArray(p) &&
        p[0] === "@babel/plugin-transform-async-to-generator")
    );
}

module.exports = setup;
