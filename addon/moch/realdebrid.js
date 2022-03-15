const RealDebridClient = require('real-debrid-api');
const { Type } = require('../lib/types');
const { isVideo, isArchive } = require('../lib/extension');
const { delay } = require('../lib/promises');
const { cacheAvailabilityResults, getCachedAvailabilityResults } = require('../lib/cache');
const StaticResponse = require('./static');
const { getMagnetLink } = require('../lib/magnetHelper');
const { chunkArray, BadTokenError } = require('./mochHelper');

const MIN_SIZE = 5 * 1024 * 1024; // 5 MB
const CATALOG_MAX_PAGE = 5;
const CATALOG_PAGE_SIZE = 100;
const NON_BLACKLIST_ERRORS = ['ESOCKETTIMEDOUT', 'EAI_AGAIN', '504 Gateway Time-out'];
const KEY = "realdebrid"

async function getCachedStreams(streams, apiKey) {
  const hashes = streams.map(stream => stream.infoHash);
  const available = await _getInstantAvailable(hashes, apiKey);
  return available && streams
      .reduce((mochStreams, stream) => {
        const cachedEntry = available[stream.infoHash];
        const cachedIds = _getCachedFileIds(stream.fileIdx, cachedEntry);
        const cachedIdsString = cachedIds.length ? cachedIds.join(',') : null;
        mochStreams[stream.infoHash] = {
          url: `${apiKey}/${stream.infoHash}/${cachedIdsString}/${stream.fileIdx}`,
          cached: !!cachedIdsString
        };
        return mochStreams;
      }, {})
}

async function _getInstantAvailable(hashes, apiKey, retries = 3, maxChunkSize = 150) {
  const cachedResults = await getCachedAvailabilityResults(hashes);
  const missingHashes = hashes.filter(infoHash => !cachedResults[infoHash]);
  if (!missingHashes.length) {
    return cachedResults
  }

  const RD = new RealDebridClient(apiKey, getDefaultOptions());
  const hashBatches = chunkArray(missingHashes, maxChunkSize)
  return Promise.all(hashBatches.map(batch => RD.torrents.instantAvailability(batch)
          .then(response => {
            if (typeof response !== 'object') {
              return Promise.reject(new Error('RD returned non JSON response: ' + response));
            }
            return processAvailabilityResults(response);
          })))
      .then(results => results.reduce((all, result) => Object.assign(all, result), {}))
      .then(results => cacheAvailabilityResults(results))
      .then(results => Object.assign(cachedResults, results))
      .catch(error => {
        if (error && error.code === 8) {
          return Promise.reject(BadTokenError);
        }
        if (!error && maxChunkSize !== 1) {
          // sometimes due to large response size RD responds with an empty body. Reduce chunk size to reduce body
          console.log(`Reducing chunk size for availability request: ${hashes[0]}`);
          return _getInstantAvailable(hashes, apiKey, retries - 1, Math.ceil(maxChunkSize / 10));
        }
        if (retries > 0 && NON_BLACKLIST_ERRORS.some(v => error && error.message && error.message.includes(v))) {
          return _getInstantAvailable(hashes, apiKey, retries - 1);
        }
        console.warn(`Failed RealDebrid cached [${hashes[0]}] torrent availability request:`, error.message);
        return undefined;
      });
}

function processAvailabilityResults(availabilityResults) {
  const processedResults = {};
  Object.entries(availabilityResults)
      .forEach(([infoHash, hosterResults]) => processedResults[infoHash] = getCachedIds(hosterResults));
  return processedResults;
}

function getCachedIds(hosterResults) {
  if (!hosterResults || Array.isArray(hosterResults)) {
    return [];
  }
  // if not all cached files are videos, then the torrent will be zipped to a rar
  return Object.values(hosterResults)
      .reduce((a, b) => a.concat(b), [])
      .filter(cached => Object.keys(cached).length && Object.values(cached).every(file => isVideo(file.filename)))
      .map(cached => Object.keys(cached))
      .sort((a, b) => b.length - a.length)
      .filter((cached, index, array) => index === 0 || cached.some(id => !array[0].includes(id)));
}

function _getCachedFileIds(fileIndex, cachedResults) {
  if (!cachedResults || !Array.isArray(cachedResults)) {
    return [];
  }

  const cachedIds = Number.isInteger(fileIndex)
      ? cachedResults.find(ids => ids.includes(`${fileIndex + 1}`))
      : cachedResults[0];
  return cachedIds || [];
}

async function getCatalog(apiKey, offset, ip) {
  if (offset > 0) {
    return [];
  }
  const options = await getDefaultOptions(ip);
  const RD = new RealDebridClient(apiKey, options);
  return _getAllTorrents(RD)
      .then(torrents => Array.isArray(torrents) ? torrents : [])
      .then(torrents => torrents
          .filter(torrent => torrent && statusReady(torrent.status))
          .map(torrent => ({
            id: `${KEY}:${torrent.id}`,
            type: Type.OTHER,
            name: torrent.filename
          })));
}

async function _getAllTorrents(RD, page = 1) {
  return RD.torrents.get(page - 1, page, CATALOG_PAGE_SIZE)
      .then(torrents => torrents && torrents.length === CATALOG_PAGE_SIZE && page < CATALOG_MAX_PAGE
          ? _getAllTorrents(RD, page + 1)
              .then(nextTorrents => torrents.concat(nextTorrents))
              .catch(() => torrents)
          : torrents)
}

async function getItemMeta(itemId, apiKey, ip) {
  const options = await getDefaultOptions(ip);
  const RD = new RealDebridClient(apiKey, options);
  return _getTorrentInfo(RD, itemId)
      .then(torrent => ({
        id: `${KEY}:${torrent.id}`,
        type: Type.OTHER,
        name: torrent.filename,
        videos: torrent.files
            .filter(file => file.selected)
            .filter(file => isVideo(file.path))
            .map((file, index) => ({
              id: `${KEY}:${torrent.id}:${file.id}`,
              title: file.path,
              released: new Date(new Date(torrent.added).getTime() + index).toISOString(),
              streams: [{ url: `${apiKey}/${torrent.hash.toLowerCase()}/null/${file.id - 1}` }]
            }))
      }))
}

async function resolve({ ip, isBrowser, apiKey, infoHash, cachedEntryInfo, fileIndex }) {
  console.log(`Unrestricting RealDebrid ${infoHash} [${fileIndex}]`);
  const options = await getDefaultOptions(ip);
  const RD = new RealDebridClient(apiKey, options);

  return _resolve(RD, infoHash, cachedEntryInfo, fileIndex, isBrowser)
      .catch(error => {
        if (accessDeniedError(error)) {
          console.log(`Access denied to RealDebrid ${infoHash} [${fileIndex}]`);
          return StaticResponse.FAILED_ACCESS;
        }
        return Promise.reject(`Failed RealDebrid adding torrent ${JSON.stringify(error)}`);
      });
}

async function _resolve(RD, infoHash, cachedEntryInfo, fileIndex, isBrowser) {
  const torrentId = await _createOrFindTorrentId(RD, infoHash, cachedEntryInfo, fileIndex);
  const torrent = await _getTorrentInfo(RD, torrentId);
  if (torrent && statusReady(torrent.status)) {
    return _unrestrictLink(RD, torrent, fileIndex, isBrowser);
  } else if (torrent && statusDownloading(torrent.status)) {
    console.log(`Downloading to RealDebrid ${infoHash} [${fileIndex}]...`);
    return StaticResponse.DOWNLOADING;
  } else if (torrent && statusMagnetError(torrent.status)) {
    console.log(`Failed RealDebrid opening torrent ${infoHash} [${fileIndex}] due to magnet error`);
    return StaticResponse.FAILED_OPENING;
  } else if (torrent && statusError(torrent.status)) {
    return _retryCreateTorrent(RD, infoHash, fileIndex);
  } else if (torrent && (statusWaitingSelection(torrent.status) || statusOpening(torrent.status))) {
    console.log(`Trying to select files on RealDebrid ${infoHash} [${fileIndex}]...`);
    return _selectTorrentFiles(RD, torrent)
        .then(() => {
          console.log(`Downloading to RealDebrid ${infoHash} [${fileIndex}]...`);
          return StaticResponse.DOWNLOADING
        })
        .catch(error => {
          console.log(`Failed RealDebrid opening torrent ${infoHash} [${fileIndex}]:`, error);
          return StaticResponse.FAILED_OPENING;
        });
  }
  return Promise.reject(`Failed RealDebrid adding torrent ${JSON.stringify(torrent)}`);
}

async function _createOrFindTorrentId(RD, infoHash, cachedFileIds, fileIndex) {
  return _findTorrent(RD, infoHash, fileIndex)
      .catch(() => _createTorrentId(RD, infoHash, cachedFileIds));
}

async function _findTorrent(RD, infoHash, fileIndex) {
  const torrents = await RD.torrents.get(0, 1) || [];
  const foundTorrents = torrents
      .filter(torrent => torrent.hash.toLowerCase() === infoHash)
      .filter(torrent => !statusError(torrent.status));
  const foundTorrent = await _findBestFitTorrent(RD, foundTorrents, fileIndex);
  return foundTorrent && foundTorrent.id || Promise.reject('No recent torrent found');
}

async function _findBestFitTorrent(RD, torrents, fileIndex) {
  if (torrents.length === 1) {
    return torrents[0];
  }
  const torrentInfos = await Promise.all(torrents.map(torrent => _getTorrentInfo(RD, torrent.id)));
  const bestFitTorrents = torrentInfos
      .filter(torrent => torrent.files.find(f => f.id === fileIndex + 1 && f.selected))
      .sort((a, b) => b.links.length - a.links.length);
  return bestFitTorrents[0] || torrents[0];
}

async function _getTorrentInfo(RD, torrentId) {
  if (!torrentId || typeof torrentId === 'object') {
    return torrentId || Promise.reject('No RealDebrid torrentId provided')
  }
  return RD.torrents.info(torrentId);
}

async function _createTorrentId(RD, infoHash, cachedFileIds) {
  const magnetLink = await getMagnetLink(infoHash);
  const addedMagnet = await RD.torrents.addMagnet(magnetLink);
  if (cachedFileIds && !['null', 'undefined'].includes(cachedFileIds)) {
    await RD.torrents.selectFiles(addedMagnet.id, cachedFileIds);
  }
  return addedMagnet.id;
}

async function _recreateTorrentId(RD, infoHash, fileIndex) {
  const newTorrentId = await _createTorrentId(RD, infoHash);
  await _selectTorrentFiles(RD, { id: newTorrentId }, fileIndex);
  return newTorrentId;
}

async function _retryCreateTorrent(RD, infoHash, fileIndex) {
  console.log(`Retry failed download in RealDebrid ${infoHash} [${fileIndex}]...`);
  const newTorrentId = await _recreateTorrentId(RD, infoHash, fileIndex);
  const newTorrent = await _getTorrentInfo(RD, newTorrentId);
  return newTorrent && statusReady(newTorrent.status)
      ? _unrestrictLink(RD, newTorrent, fileIndex)
      : StaticResponse.FAILED_DOWNLOAD;
}

async function _selectTorrentFiles(RD, torrent, fileIndex) {
  torrent = statusWaitingSelection(torrent.status) ? torrent : await _openTorrent(RD, torrent.id);
  if (torrent && torrent.files && statusWaitingSelection(torrent.status)) {
    const videoFileIds = Number.isInteger(fileIndex) ? `${fileIndex + 1}` : torrent.files
        .filter(file => isVideo(file.path))
        .filter(file => file.bytes > MIN_SIZE)
        .map(file => file.id)
        .join(',');
    return RD.torrents.selectFiles(torrent.id, videoFileIds);
  }
  return Promise.reject('Failed RealDebrid torrent file selection')
}

async function _openTorrent(RD, torrentId, pollCounter = 0, pollRate = 2000, maxPollNumber = 15) {
  return _getTorrentInfo(RD, torrentId)
      .then(torrent => torrent && statusOpening(torrent.status) && pollCounter < maxPollNumber
          ? delay(pollRate).then(() => _openTorrent(RD, torrentId, pollCounter + 1))
          : torrent);
}

async function _unrestrictLink(RD, torrent, fileIndex, isBrowser) {
  const targetFile = torrent.files.find(file => file.id === fileIndex + 1)
      || torrent.files.filter(file => file.selected).sort((a, b) => b.bytes - a.bytes)[0];
  if (!targetFile.selected) {
    console.log(`Target RealDebrid file is not downloaded: ${JSON.stringify(torrent)}`);
    await _recreateTorrentId(RD, torrent.hash.toLowerCase(), fileIndex);
    return StaticResponse.DOWNLOADING;
  }

  const selectedFiles = torrent.files.filter(file => file.selected);
  const fileLink = torrent.links.length === 1
      ? torrent.links[0]
      : torrent.links[selectedFiles.indexOf(targetFile)];

  if (!fileLink || !fileLink.length) {
    return Promise.reject(`No RealDebrid links found for ${torrent.hash} [${fileIndex}]`);
  }

  return _unrestrictFileLink(RD, fileLink, torrent, fileIndex, isBrowser);
}

async function _unrestrictFileLink(RD, fileLink, torrent, fileIndex, isBrowser) {
  return RD.unrestrict.link(fileLink)
      .then(response => {
        if (isArchive(response.download)) {
          return StaticResponse.FAILED_RAR;
        }
        // if (isBrowser && response.streamable) {
        //   return RD.streaming.transcode(response.id)
        //       .then(streamResponse => streamResponse.apple.full)
        // }
        return response.download;
      })
      .then(unrestrictedLink => {
        console.log(`Unrestricted RealDebrid ${torrent.hash} [${fileIndex}] to ${unrestrictedLink}`);
        return unrestrictedLink;
      })
      .catch(error => {
        if (error.code === 19) {
          return _retryCreateTorrent(RD, torrent.hash.toLowerCase(), fileIndex);
        }
        return Promise.reject(error);
      });
}

function statusError(status) {
  return ['error', 'magnet_error'].includes(status);
}

function statusMagnetError(status) {
  return status === 'magnet_error';
}

function statusOpening(status) {
  return status === 'magnet_conversion';
}

function statusWaitingSelection(status) {
  return status === 'waiting_files_selection';
}

function statusDownloading(status) {
  return ['downloading', 'uploading', 'queued'].includes(status);
}

function statusReady(status) {
  return ['downloaded', 'dead'].includes(status);
}

function accessDeniedError(error) {
  return [9, 20].includes(error && error.code);
}

async function getDefaultOptions(ip) {
  return { ip, timeout: 30000 };
}

module.exports = { getCachedStreams, resolve, getCatalog, getItemMeta };
