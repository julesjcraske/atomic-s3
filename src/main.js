
const awspublish = require('gulp-awspublish');
const del = require('del');
const vfs = require('vinyl-fs');
const path = require('path');
const through2 = require('through2').obj;
const stream = require('stream');

const prepareOptions = require('./prepare-options');
const validateOptions = require('./validate-options');

/*
 * Publish the given source files to AWS
 * with the given headers
 */
function publishToS3(publisher, simulate, force) {
  if (force) {
    del.sync('./.awspublish-*');
  }

  const bucket = publisher.config.params.Bucket;

  // Config object is passed to
  // new AWS.S3() as documented here:
  //   http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#constructor-property

  // We want to construct a pipeline that consists of multiple segments piped together.
  // The consumer of this pipeline needs to be able to pipe into its first segment
  // and to maybe continue it, i.e. to access its last segment. So we're returning
  // an array with the first and last segments of this pipeline.

  const first = publisher.publish({ 'x-amz-acl': 'private' }, {
    force,
    simulate: simulate === true,
  });
  let cache = null;
  if (!force) {
    cache = first.pipe(publisher.cache());
  }
  let reporter = awspublish.reporter();
  if (simulate === true) {
    reporter = through2((file, _enc, cb) => {
      console.log(`s3://${bucket}/${file.s3.path}`); // eslint-disable-line
      console.log(file.s3.headers); // eslint-disable-line
      cb(null, file);
    });
  }
  const last = (cache || first).pipe(reporter);
  return [first, last];
}


//
// https://github.com/jussi-kalliokoski/gulp-awspublish-router/blob/master/lib/utils/initFile.js
//
function s3Init(file, s3Folder) {
  if (file.s3) {
    return;
  }
  file.s3 = {};               // eslint-disable-line no-param-reassign
  file.s3.headers = {};       // eslint-disable-line no-param-reassign
  file.s3.path = file.path    // eslint-disable-line no-param-reassign
    .replace(file.base, s3Folder || '')
    .replace(new RegExp(`\\${path.sep}g`), '/');
}


/*
 * Get file streams for all entry points assets
 * (assets without rev urls)
 */
function entryPointStream(sourceFolder, entryPoints, s3Folder) {
  return vfs.src(entryPoints, {
    cwd: sourceFolder || 'dist',
  })
  .pipe(through2((file, _enc, cb) => {
    s3Init(file, s3Folder);
    cb(null, file);
  }));
}


/*
 * Get file streams for all hashed assets
 * (assets with rev urls)
 *
 * targetFolder -- folder to publish into
 * maxAge -- expiry age for header
 */
function assetStream(sourceFolder, entryPoints, maxAge, s3Folder) {
  if (maxAge === null || !isFinite(maxAge)) {
    maxAge = 3600; // eslint-disable-line no-param-reassign
  }

  const headers = {
    'Cache-Control': `max-age=${maxAge}, public`,
  };

  // Select everything BUT the entrypoints
  const src = entryPoints.map(f => `!${f}`);
  src.unshift('**/*.*');

  return vfs.src(src, {
    cwd: sourceFolder || 'dist',
  })
    .pipe(through2((file, _enc, cb) => {
      s3Init(file, s3Folder);
      Object.assign(file.s3.headers, headers);
      cb(null, file);
    }));
}


function publishInSeries(streams, opts) {
  // We want to construct a new stream that combines others
  // sequentially. We pipe to it the first one, passing the option end: false,
  // listen for the 'end' event of the first stream and then pipe it the second one,
  // not passing the end option.

  const output = stream.PassThrough({ // eslint-disable-line new-cap
    objectMode: true,
  });

  for (let i = 0; i < streams.length - 1; i++) {
    const nextStream = streams[i + 1];
    streams[i].once('end', () => nextStream.pipe(output));
  }

  const publisher = awspublish.create(opts.s3options);
  const s3 = publishToS3(publisher,
    opts.simulateDeployment || false,
    opts.forceDeployment || false); // we get the first and last segments of the pipeline

  streams[0]
    .pipe(output, {
      end: false,
    })
    .pipe(s3[0]);

  return s3[1];
}


function publish(options, cb) {
  const opts = prepareOptions(options);
  const errors = validateOptions(opts);
  if (errors) {
    throw (Error(errors));
  }

  const asset = assetStream(opts.path, opts.entryPoints, opts.maxAge, '');
  const entry = entryPointStream(opts.path, opts.entryPoints);

  // It is important to do deploy in series to
  // achieve an "atomic" update. uploading index.html
  // before hashed assets would be bad -- JOJ

  publishInSeries([asset, entry], opts)
    .on('end', () => { cb(false); })
    .on('error', (err) => { cb(err); });
}


module.exports = {
  entryPointStream,
  assetStream,
  publishToS3,
  publishInSeries,
  publish,
};
