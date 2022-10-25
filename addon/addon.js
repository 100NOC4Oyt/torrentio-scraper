const Bottleneck = require('bottleneck');
const { addonBuilder } = require('stremio-addon-sdk');
const { Type } = require('./lib/types');
const { dummyManifest } = require('./lib/manifest');
const { cacheWrapStream } = require('./lib/cache');
const { toStreamInfo, applyStaticInfo } = require('./lib/streamInfo');
const repository = require('./lib/repository');
const applySorting = require('./lib/sort');
const applyFilters = require('./lib/filter');
const { applyMochs, getMochCatalog, getMochItemMeta } = require('./moch/moch');

const CACHE_MAX_AGE = parseInt(process.env.CACHE_MAX_AGE) || 4 * 60 * 60; // 4 hours in seconds
const CACHE_MAX_AGE_EMPTY = 60; // 60 seconds
const STALE_REVALIDATE_AGE = 4 * 60 * 60; // 4 hours
const STALE_ERROR_AGE = 7 * 24 * 60 * 60; // 7 days

const builder = new addonBuilder(dummyManifest());
const limiter = new Bottleneck({
  maxConcurrent: process.env.LIMIT_MAX_CONCURRENT || 20,
  highWater: process.env.LIMIT_QUEUE_SIZE || 50,
  strategy: Bottleneck.strategy.OVERFLOW
});

builder.defineStreamHandler((args) => {
  if (!args.id.match(/tt\d+/i) && !args.id.match(/kitsu:\d+/i)) {
    return Promise.resolve({ streams: [] });
  }

  return cacheWrapStream(args.id, () => limiter.schedule(() => streamHandler(args)
      .then(records => records
          .sort((a, b) => b.torrent.seeders - a.torrent.seeders || b.torrent.uploadDate - a.torrent.uploadDate)
          .map(record => toStreamInfo(record)))))
      .then(streams => applyFilters(streams, args.extra))
      .then(streams => applySorting(streams, args.extra))
      .then(streams => applyStaticInfo(streams))
      .then(streams => applyMochs(streams, args.extra))
      .then(streams => ({
        streams: streams,
        cacheMaxAge: streams.length ? CACHE_MAX_AGE : CACHE_MAX_AGE_EMPTY,
        staleRevalidate: STALE_REVALIDATE_AGE,
        staleError: STALE_ERROR_AGE
      }))
      .catch(error => {
        return Promise.reject(`Failed request ${args.id}: ${error}`);
      });
});

builder.defineCatalogHandler((args) => {
  const mochKey = args.id.replace("torrentio-", '');
  console.log(`Incoming catalog ${args.id} request with skip=${args.extra.skip || 0}`)
  return getMochCatalog(mochKey, args.extra)
      .then(metas => ({
        metas: metas,
        cacheMaxAge: 0
      }))
      .catch(error => {
        return Promise.reject(`Failed retrieving catalog ${args.id}: ${JSON.stringify(error)}`);
      });
})

builder.defineMetaHandler((args) => {
  const [mochKey, metaId] = args.id.split(':');
  console.log(`Incoming debrid meta ${args.id} request`)
  return getMochItemMeta(mochKey, metaId, args.extra)
      .then(meta => ({
        meta: meta,
        cacheMaxAge: CACHE_MAX_AGE
      }))
      .catch(error => {
        return Promise.reject(`Failed retrieving catalog meta ${args.id}: ${JSON.stringify(error)}`);
      });
})

async function streamHandler(args) {
  if (args.type === Type.MOVIE) {
    return movieRecordsHandler(args);
  } else if (args.type === Type.SERIES) {
    return seriesRecordsHandler(args);
  }
  return Promise.reject('not supported type');
}

async function seriesRecordsHandler(args) {
  if (args.id.match(/^tt\d+:\d+:\d+$/)) {
    const parts = args.id.split(':');
    const imdbId = parts[0];
    const season = parts[1] !== undefined ? parseInt(parts[1], 10) : 1;
    const episode = parts[2] !== undefined ? parseInt(parts[2], 10) : 1;
    return repository.getImdbIdSeriesEntries(imdbId, season, episode);
  } else if (args.id.match(/^kitsu:\d+(?::\d+)?$/i)) {
    const parts = args.id.split(':');
    const kitsuId = parts[1];
    const episode = parts[2] !== undefined ? parseInt(parts[2], 10) : undefined;
    return episode !== undefined
        ? repository.getKitsuIdSeriesEntries(kitsuId, episode)
        : repository.getKitsuIdMovieEntries(kitsuId);
  }
  // return Promise.reject(`Unsupported series id type: ${args.id}`);
  return Promise.resolve([]);
}

async function movieRecordsHandler(args) {
  if (args.id.match(/^tt\d+$/)) {
    const parts = args.id.split(':');
    const imdbId = parts[0];
    return repository.getImdbIdMovieEntries(imdbId);
  } else if (args.id.match(/^kitsu:\d+(?::\d+)?$/i)) {
    return seriesRecordsHandler(args);
  }
  // return Promise.reject(`Unsupported movie id type: ${args.id}`);
  return Promise.resolve([]);
}

module.exports = builder.getInterface();
