const fs = require("fs");
const babel = require("gulp-babel");
const changed = require("gulp-changed");
const sourcemaps = require("gulp-sourcemaps");
const sass = require("gulp-sass");
const notify = require("gulp-notify");
const concat = require("gulp-concat");

const _ = require("lodash");
const envify = require("envify/custom");
const watchify = require("watchify");
const browserify = require("browserify");
const source = require("vinyl-source-stream");
const buffer = require("vinyl-buffer");
const gutil = require("gulp-util");

const madge = require("madge");
const Promise = require("bluebird");
const rimraf = Promise.promisify(require("rimraf"));
const glob = Promise.promisify(require("glob"));

function mergeWithDefaultOpts(opts) {
  const defaults = {
    babelConfig: {
      presets: ["es2015", "react", "stage-1"]
        .map(p => `babel-preset-${p}`)
        .map(require.resolve),
      plugins: ["transform-flow-strip-types", "transform-object-rest-spread"]
        .map(p => `babel-plugin-${p}`)
        .map(require.resolve),
    },
    es5Dir: "es5",
    bundleDir: "dist",
    cleanDirs: ["es5"],
    jsSrc: null,
    madgeSrc: null,
    sassSrc: null,
    sassIncludePaths: [],
    browserifyOptions: {
      entries: [],
      plugin: [],
    },
    browserifyEnvConfig: {},
    useNotify: true,
  };

  return _.merge(defaults, opts);
}

const ENV = process.env.CONFIG_ENV && `.${process.env.CONFIG_ENV}` || "";

function setup(gulp, opts) {
  const runSequence = require("run-sequence").use(gulp);

  opts = mergeWithDefaultOpts(opts);
  const usingBabel = opts.jsSrc && opts.babelConfig && opts.es5Dir;
  const madgeSrc = opts.madgeSrc || opts.jsSrc;
  const usingMadge = madgeSrc;
  const usingSass = opts.sassSrc && opts.bundleDir;
  const usingBrowserify = opts.browserifyOptions.entries.length > 0 &&
    opts.bundleDir;
  const usingBrowserifyConfigEnv = usingBrowserify &&
    typeof opts.browserifyEnvConfig.src === "function";
  const usingWatch = usingBabel || usingSass || usingBrowserifyConfigEnv;

  const commonTasks = [
    "clean",
    usingBabel && "babel",
    usingMadge && "madge",
    usingSass && "sass",
  ];

  gulp.task("default", function (callback) {
    const seq = [
      ...commonTasks,
      usingBrowserifyConfigEnv && "browserify-config",
      usingBrowserify && "watchify",
      usingWatch && "watch"
    ]
    .filter(x => !!x);

    runSequence(...seq, callback);
  });

  gulp.task("dev", function (callback) {
    const seq = [
      ...commonTasks,
      usingBrowserifyConfigEnv && "browserify-config",
      usingBrowserify && "browserify",
    ]
    .filter(x => !!x);

    runSequence(...seq, callback);
  });

  gulp.task("prod", function (callback) {
    const seq = [
      ...commonTasks,
      usingBrowserifyConfigEnv && "browserify-config",
      usingBrowserify && "browserify-prod",
    ]
    .filter(x => !!x);

    runSequence(...seq, callback);
  });

  gulp.task("clean", function (callback) {
    Promise.each(opts.cleanDirs, dir => {
      return rimraf(dir);
    })
    .asCallback(callback);
  });

  // NOTE: if using generators, check README
  // https://www.npmjs.com/package/gulp-babel
  usingBabel &&
  gulp.task("babel", function () {
    const babelStream = babel(opts.babelConfig);

    babelStream.on("error", err => {
      gutil.log("Babel Error", err);
      babelStream.end();
    });

    return gulp.src(opts.jsSrc)
      .pipe(changed(opts.es5Dir))
      .pipe(sourcemaps.init())
      .pipe(babelStream)
      .pipe(sourcemaps.write())
      .pipe(gulp.dest(opts.es5Dir));
    // .pipe(notify("ES5 compiled."));
  });

  usingMadge && gulp.task("madge", function () {
    return glob(madgeSrc)
      .then(files =>
        madge(files)
      )
      .then(res => {
        const deps = res.circular();

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
  gulp.task("sass", function () {
    return gulp.src(opts.sassSrc)
      .pipe(sourcemaps.init())
      .pipe(sass({
        includePaths: opts.sassIncludePaths,
      })
      .on("error", sass.logError))
      .pipe(sourcemaps.write())
      .pipe(concat("bundle.css"))
      .pipe(gulp.dest(opts.bundleDir));
    // .pipe(notify("CSS compiled."));
  });

  usingWatch &&
  gulp.task("watch", function () {
    usingBabel && gulp.watch(opts.jsSrc , ["babel", "madge"]);
    usingSass && gulp.watch(opts.sassSrc, ["sass"]);
    usingBrowserifyConfigEnv &&
      gulp.watch(opts.browserifyEnvConfig.src(ENV), ["browserify-config"]);
  });

  usingBrowserifyConfigEnv &&
  gulp.task("browserify-config", function () {
    fs.writeFileSync(
      `${opts.bundleDir}/config.browserify.js`,
      fs.readFileSync(opts.browserifyEnvConfig.src(ENV))
    );
  });

  usingBrowserify &&
  gulp.task("browserify", function () {
    const b = browserify({ ...opts.browserifyOptions, debug: true });
    b.on("log", gutil.log);
    return bundle(b);
  });

  usingBrowserify &&
  gulp.task("browserify-prod", function () {
    const b = browserify({ ...opts.browserifyOptions, debug: false });
    b.on("log", gutil.log);
    return bundle(b);
  });

  usingBrowserify &&
  gulp.task("watchify", function () {
    const b = browserify({
      cache: {},
      packageCache: {},
      plugin: [...opts.browserifyOptions.plugin, watchify],
      ...opts.browserifyOptions,
    });

    b.on("log", gutil.log);
    b.on("update", function () {
      return bundle(b);
    });

    return bundle(b);
  });

  function bundle(b) {
    b.transform(envify({
      _: "purge",
      CONFIG_ENV: process.env.CONFIG_ENV || "",
      NODE_ENV: process.env.NODE_ENV || "development",
    }));

    return b.bundle()
      .on("error", gutil.log.bind(gutil, "Browserify Error"))
      .pipe(source("bundle.js"))
      .pipe(buffer())
      .pipe(notify("Browserified."))
      // Add transformation tasks to the pipeline here.
      .pipe(gulp.dest(opts.bundleDir));
  }

  return { runSequence };
}
module.exports = setup;
