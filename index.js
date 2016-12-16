#!/usr/bin/env node

var archiver = require('hypercore-archiver')
var irc = require('irc')
var mkdirp = require('mkdirp')
var minimist = require('minimist')
var defaults = require('datland-swarm-defaults')
var disc = require('discovery-channel')(defaults({hash: false}))
var net = require('net')
var pump = require('pump')
var prettyBytes = require('pretty-bytes')
var prettyTime = require('pretty-time')
var extend = require('xtend')

var argv = minimist(process.argv.slice(2), {
  alias: {
    channel: 'c',
    cwd: 'd',
    server: 's',
    name: 'n',
    port: 'p',
    ircPort: 'irc-port'
  },
  default: {
    port: 3282,
    cwd: 'hypercore-archiver',
    name: 'archive-bot',
    server: 'irc.freenode.net'
  }
})

mkdirp.sync(argv.cwd)

var started = process.hrtime()
var pending = []
var ar = archiver(argv.cwd)
var server = net.createServer(function (socket) {
  pump(socket, ar.replicate({passive: true}), socket)
})

server.listen(argv.port, function () {
  ar.list().on('data', function (key) {
    setTimeout(join, Math.floor(Math.random() * 30 * 1000))

    function join () {
      console.log('Joining', key.toString('hex'))
      disc.join(ar.discoveryKey(key), server.address().port)
    }
  })

  ar.changes(function (err, feed) {
    if (err) throw err
    disc.join(feed.discoveryKey, server.address().port)
    console.log('Changes feed available at: ' + feed.key.toString('hex'))
    console.log('Listening on port', server.address().port)
  })
})

var client = null

if (argv.channel) {
  var ircOpts = extend({}, argv, {
    channels: [argv.channel],
    retryCount: 1000,
    autoRejoin: true
  })
  ircOpts.port = argv.ircPort

  console.log('Connecting to IRC', argv.server, 'as', argv.name)
  client = new irc.Client(argv.server, argv.name, ircOpts)

  client.on('registered', function (msg) {
    console.log('Connected to IRC, listening for messages')
  })

  client.on('message', function (from, to, message) {
    var op = parse(message)
    if (!op) return
    var channel = (to === argv.name) ? from : argv.channel
    var key = op.key
    switch (op.command) {
      case 'add':
        pending.push({key: key, channel: channel})
        add(key, channel, function (err) {
          if (err) return sendMessage(err, channel)
        })
        return
      case 'rm':
      case 'remove':
        pending = pending.filter(function(obj) {
          // remove meta keys + content keys
          return obj.key !== key && obj.metaKey !== key
        })
        ar.remove(new Buffer(key, 'hex'), function (err) {
          if (err) return sendMessage(err, channel)
          sendMessage(null, channel, 'Removing ' + key)
        })
        return
      case 'status':
        status(function (err, msg) {
          sendMessage(err, channel, msg)
        })
        return
    }
  })
}

function sendMessage (err, channel, msg) {
  if (err && client) return client.say(channel, 'Error: ' + err.message)
  else if (err) return console.error(err)
  if (client) client.say(channel, msg)
}

function add (key, channel, cb) {
  sendMessage(null, channel, 'Adding ' + key)
  ar.add(new Buffer(key, 'hex'), function (err) {
    if (err) return cb(err)
    ar.get(key, function (err, feed, content) {
      if (err) return cb(err)
      if (!content) return waitForDownload(feed)
      pending.push({key: content.key.toString('hex'), metaKey: key})
      waitForDownload(content)
      cb(null)

      function waitForDownload (feed) {
        setTimeout(function () {
          feed.once('download', function () {
            var msg = 'Starting archive of ' + prettyBytes(feed.bytes) + ' from ' + key
            sendMessage(null, channel, msg)
          })
        }, 200)
      }
    })
  })
}

ar.on('archived', function (key, feed) {
  key = key.toString('hex')
  console.log('Feed archived', key)
  pending = pending.filter(function (obj) {
    if (key !== obj.key) return true
    if (obj.metaKey) {
      // content feed is done
      done(obj.metaKey, feed)
      return false
    } else if (!checkContent()) {
      // hypercore feed is done
      done(obj.key, feed)
      return false
    }
    // metadata feed done, wait for content
    return true
  })

  function checkContent () {
    var hasContent = pending.filter(function (obj) {
      if (obj.metaKey === key) return true
      return false
    })
    return hasContent.length
  }

  function done (key, feed) {
    pending = pending.filter(function (obj) {
      if (key !== obj.key) return true
      if (key === obj.metaKey) return false // remove content key from pending
      var msg = key + ' has been fully archived (' + prettyBytes(feed.bytes) + ')'
      if (client) client.say(obj.channel, msg)
      console.log(msg)
      return false // remove meta key from pending
    })
  }
})

ar.on('remove', function (key) {
  console.log('Removing', key.toString('hex'))
  disc.leave(ar.discoveryKey(key), server.address().port)
})

ar.on('add', function (key) {
  console.log('Adding', key.toString('hex'))
  disc.join(ar.discoveryKey(key), server.address().port)
})

function status (cb) {
  var cnt = 0
  ar.list().on('data', ondata).on('end', reply).on('error', cb)

  function ondata () {
    cnt++
  }

  function reply () {
    cb(null, 'Uptime: ' + prettyTime(process.hrtime(started)) + '. Archiving ' + cnt + ' hypercores')
  }
}

function parse (message) {
  message = message.trim()

  if (message[0] === '!') {
    message = message.slice(1)
  } else {
    var name = (message.indexOf(':') > -1 ? message.split(':')[0] : '').trim().replace(/\d+$/, '')
    if (name !== argv.name) return null
  }

  message = message.split(':').pop().trim()
  if (message.indexOf(' ') === -1) return {command: message, key: null}
  var parts = message.split(' ')
  if (!/^[0-9a-f]{64}$/.test(parts[1])) return null
  return {
    command: parts[0],
    key: parts[1]
  }
}
