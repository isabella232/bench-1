'use strict'

const keyspace = require('keyspace')
const bytes = require('bytes')
const delayed = require('delayed').delayed
const ldu = require('../lib/level-du')
const lcompact = require('../lib/level-compact')
const window = 1000
const progressWindow = window * 100

exports.defaults = function (options) {
  const defaults = {
    benchmark: {
      n: 1e6,
      concurrency: 1,
      valueSize: 100,
      keys: 'random',
      values: 'random',
      seed: 'seed'
    }
  }

  const b = options.benchmark || {}

  // TODO: should we instead have a --method flag? E.g. --method [ get --no-fillCache ]
  if (!b.get && !b.iterator && !b.stream) {
    defaults.benchmark.get = true
  } else if (b.iterator || b.stream) {
    defaults.benchmark.keys = 'seq'
  }

  return defaults
}

exports.plot = require('./read.plot')

exports.run = function (factory, stream, options) {
  if (options.n < window) {
    throw new RangeError('The "n" option must be >= ' + window)
  }

  const readGenerator = keyspace(options.n, options)
  const writeGenerator = keyspace(options.n, Object.assign({}, options, {
    // Writing ordered data in reverse is the fastest (at least in LevelDB)
    keys: 'seqReverse'
  }))

  stream.write('Elapsed (ms), Entries, Bytes, SMA ms/read, CMA MB/s\n')

  function load (db, callback) {
    let writes = 0
    loop()

    function loop (err) {
      if (err) return callback(err)

      if (writes % progressWindow === 0 || writes >= options.n) {
        console.log('Load', writes, Math.round(writes / options.n * 100) + '%')
      }

      if (writes >= options.n) {
        return callback()
      }

      const batchSize = Math.min(1000, options.n - writes)
      const ops = new Array(batchSize)

      for (let i = 0; i < batchSize; i++) {
        const key = writeGenerator.key(writes++)
        const value = writeGenerator.value()

        // TODO: what if db has encodings?
        ops[i] = { type: 'put', key, value }
      }

      // Wait for last batch to be flushed to disk (if supported)
      const isLastBatch = writes >= options.n
      const batchOptions = { sync: isLastBatch }

      db.batch(ops, batchOptions, loop)
    }
  }

  function compact (db, callback) {
    // Flip start & end because writeGenerator is in reverse
    const start = writeGenerator.key(options.n - 1)
    const end = writeGenerator.key(0)

    lcompact(db, start, end, delayed(function (err) {
      if (err) return callback(err)

      ldu(db, function (err, size) {
        if (err) return callback(err)
        if (size) console.log('Size', bytes.format(size))
        callback()
      })
    }, 500))
  }

  function start (db) {
    const startTime = Date.now()

    // TODO: what if db has encodings?
    const getOptions = Object.assign({}, isOptions(options.get) ? options.get : {}, {
      asBuffer: !!options.valueAsBuffer
    })

    // TODO: what if db has encodings?
    const iteratorOpts = Object.assign({}, isOptions(options.iterator) ? options.iterator : {}, {
      keyAsBuffer: !!options.keyAsBuffer,
      valueAsBuffer: !!options.valueAsBuffer
    })

    let inProgress = 0
    let totalReads = 0
    let totalBytes = 0
    let timesAccum = 0
    let lastKey
    let elapsed
    let iterator

    function report () {
      if (inProgress) return

      console.log(
        'Read', options.n, 'entries in',
        Math.floor((Date.now() - startTime) / 1e3) + 's,',
        (Math.floor((totalBytes / 1048576) * 100) / 100) + 'MB'
      )

      // TODO: end iterator and/or read stream
      stream.end()

      db.close(function (err) {
        if (err) throw err
      })
    }

    function read () {
      if (inProgress >= options.concurrency) return
      if (totalReads >= options.n) return report()

      inProgress++

      if (totalReads % progressWindow === 0) {
        console.log('' + inProgress, totalReads,
          Math.round(totalReads / options.n * 100) + '%')
      }

      if (totalReads % window === 0) {
        elapsed = Date.now() - startTime
        stream.write(
          elapsed +
          ',' + totalReads +
          ',' + totalBytes +
          ',' + (timesAccum / window / 1e6).toFixed(3) +
          ',' + ((totalBytes / 1048576) / (elapsed / 1e3)).toFixed(3) +
          '\n')
        timesAccum = 0
      }

      let start

      if (options.iterator) {
        if (options.concurrency > 1) {
          // TODO: create pool of iterators?
          throw new Error('The "concurrency" option is not supported yet with "iterator"')
        }

        // TODO: if limit is defined, select a new range (TBD)
        if (iterator === undefined) {
          iterator = db.iterator(iteratorOpts)
        }

        start = process.hrtime()
        iterator.next(handleIteratorNext)
      } else if (options.stream) {
        throw new Error('Not implemented')
      } else {
        const key = lastKey = readGenerator.key(totalReads++)
        start = process.hrtime()

        // TODO: what if db has encodings?
        db.get(key, getOptions, handleGet)
      }

      function handleIteratorNext (err, key, value) {
        const duration = process.hrtime(start)
        if (err) return next(err)

        if (key === undefined && value === undefined) {
          if (totalReads < options.n && !hasLimit(iteratorOpts)) {
            return next(new Error('Premature end'))
          }

          return iterator.end(handleIteratorEnd)
        }

        totalReads++
        next(null, duration, key, value)
      }

      function handleIteratorEnd (err) {
        if (err) return next(err)
        iterator = undefined
        next(null, null)
      }

      function handleGet (err, value) {
        // TODO: should we exclude the key from bytes read?
        next(err, process.hrtime(start), lastKey, value)
      }

      function next (err, duration, key, value) {
        if (err) throw err

        if (duration !== null) {
          const nano = (duration[0] * 1e9) + duration[1]

          totalBytes += byteLength(key, value)
          timesAccum += nano
        }

        inProgress--
        process.nextTick(read)
      }
    }

    for (let i = 0; i < options.concurrency; i++) read()
  }

  // TODO (once stream is sync): skip setTimeout
  setTimeout(function () {
    factory(function (err, db) {
      if (err) throw err

      // After loading, wait a bit for data to be flushed
      load(db, delayed(function (err) {
        if (err) throw err

        compact(db, function (err) {
          if (err) throw err

          start(db)
        })
      }, 500))
    })
  }, 500)
}

function byteLength (key, value) {
  let length = 0

  if (key != null) length += Buffer.byteLength(key)
  if (value != null) length += Buffer.byteLength(value)

  return length
}

function isOptions (obj) {
  return obj !== null && typeof obj === 'object'
}

function hasLimit (options) {
  return options.limit != null && options.limit >= 0
}
