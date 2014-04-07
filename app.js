// The App
var express = require('express');
var fs = require('fs');
var http = require('http');
var httpProxy = require('http-proxy');

/*
 * Configuration
 */
//  Detect if environment is Heroku
var isHeroku = false;
if (process.env.PORT !== undefined) {
    isHeroku = true;
}
var proxyTarget;
if (isHeroku) {
    var host = 'lajv.s3-website-eu-west-1.amazonaws.com';
    proxyTarget = 'http://' + host;
} else {
    proxyTarget = 'http://localhost:4000';
}
console.log("Proxy target: " + proxyTarget);
var manifestFilename = 'live-manifest.mpd';

/*
 * Initialization
 */
var app = express();
app.disable('etag');

var proxy = httpProxy.createProxyServer({
    target: proxyTarget
});

var availTime;
var reset = function() {
    availTime = new Date(new Date() - 60 * 1000); // 60 seconds ago
};
reset();

/*
 * Constants
 */
var segDur = 4; // In seconds
var timeShiftBuffer = 10; // In seconds
var suggestedPresentationDelay = 30; // In seconds
var videoTimescale = 90000;
var audioTimescale = 48000;

/*
 * Calculated values
 */
var availableSegmentsTime = timeShiftBuffer + suggestedPresentationDelay;
// Don't buffer more than what's available, we don't want 404s
var minBufferTime = suggestedPresentationDelay / 2;
var numAvailSegs = Math.ceil(availableSegmentsTime / segDur);
var minUpdateTime = segDur;
var videoSegDur = segDur * videoTimescale;
var audioSegDur = segDur * audioTimescale;

/*
 * Manifest manipulations
 */
var manifest = fs.readFileSync(manifestFilename).toString();
manifest = manifest.split("$AvailabilityStartTime$").join(availTime.toISOString());
manifest = manifest.split("$MaxSegmentDuration$").join(segDur);
manifest = manifest.split("$MinimumUpdatePeriod$").join(minUpdateTime);
manifest = manifest.split("$MinBufferTime$").join(minBufferTime);
manifest = manifest.split("$TimeShiftBufferDepth$").join(timeShiftBuffer);
manifest = manifest.split("$SuggestedPresentationDelay$").join(suggestedPresentationDelay);
manifest = manifest.split("$VideoTimescale$").join(videoTimescale);
manifest = manifest.split("$AudioTimescale$").join(audioTimescale);
// manifest = manifest.split("$VideoPresentationTimeOffset$").join(-1 * suggestedPresentationDelay * videoTimescale);
// manifest = manifest.split("$AudioPresentationTimeOffset$").join(-1 * suggestedPresentationDelay * audioTimescale);
console.log("Manifest template generated:\n\n" + manifest + "\n\n");

/*
 * Logging and setting of 'X-Response-Time' header
 */
app.use(function(req, res, next) {
    var start = Date.now();
    console.log('Request for %s initiated', req.url);
    res.on('header', function() {
        var duration = Date.now() - start;
        res.setHeader('X-Response-Time', duration + ' ms');
        console.log('Request for %s served in %s ms', req.url, duration);
    });
    next();
});

/*
 * Cross Origin Allowance
 */
app.use(function(req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    next();
});

/*
 * Hack which closes the connection after a HEAD request.
 * Needed since node does not seem to flush the written data otherwise
 */
app.use(function(req, res, next) {
    if (req.method == 'HEAD')
        res.shouldKeepAlive = false;
    next();
});

/*
 * Help functions
 */
var getCurrentInfo = function() {
    var info = {};
    info.now = new Date();
    info.currSeg = Math.floor((info.now - availTime) / segDur / 1000);
    // currSeg is yet not ready, currSeg-1 is the latest 
    console.log("Current segment: " + info.currSeg);

    info.first = info.currSeg - numAvailSegs;
    info.last = info.currSeg - 1;
    console.log("Num of segments: " + numAvailSegs + " First: " + info.first + " Last: " + info.last);

    // It's not possible to add time to a date, however it's possible to subtract a negative number...
    var firstTime = new Date(availTime - (-info.first) * segDur * 1000);
    console.log("First segment time: " + firstTime);

    info.videoOffset = (firstTime - availTime) / 1000 * videoTimescale;
    console.log("First video segment offset: " + info.videoOffset);

    info.audioOffset = (firstTime - availTime) / 1000 * audioTimescale;
    console.log("First audio segment offset: " + info.audioOffset);

    return info;
};

/*
 * Manifest resource
 */
app.get('/envivio/manifest.mpd', function(req, res) {
    console.log("Manifest request from: " + req.connection.remoteAddress);
    res.setHeader('Content-Type', 'application/xml');
    var info = getCurrentInfo();
    res.send(manifest
        .split('$PublishTime$').join(info.now.toISOString())
        .split('$VideoStart$').join(info.videoOffset)
        .split('$AudioStart$').join(info.audioOffset)
    );
});

/*
 * Reset of Availability Time
 */
app.get('/envivio/reset', function(req, res) {
    console.log("Availability time for manifest have been reset");
    reset();
    res.send(202);
});

/*
 * Media file requests
 */
app.get('*', function(req, res) {
    console.log("Media request from " + req.connection.remoteAddress + " for " + req.path);
    var info = getCurrentInfo();

    var regexpAudio = /\/audio/;
    var regexpVideo = /\/video/;

    var timescale;
    if ( !! req.path.match(regexpVideo)) {
        timescale = videoTimescale;
        console.log("Requesting video segment");
    } else if ( !! req.path.match(regexpAudio)) {
        timescale = audioTimescale;
        console.log("Requesting audio segment");
    } else {
        res.send(400);
        console.log("Neither audio nor video");
        return;
    }

    var regexpNumber = /\/(\d+)\./;
    if (req.path.match(regexpNumber)) {
        res.setHeader('Cache-Control', 'no-cache, private, no-store, must-revalidate');

        var number = req.path.match(regexpNumber)[1];
        var seg = number; // / timescale / segDur;
        console.log("Requested segment: " + seg);

        if (seg > info.last) {
            console.log("Requesting a segment which is not yet available");
            if (req.method == 'HEAD') {
                res.send(404, null);
            } else {
                res.send(404, "Segment is not yet available");
            }
            console.log("Requst method: " + req.method);
            return;
        }

        var moduloNumber = number % 64;

        var urlParts = req.url.split(regexpNumber);
        req.url = urlParts[0] + '/' + moduloNumber + '.' + urlParts[2];

        var pathParts = req.path.split(regexpNumber);
        req.path = pathParts[0] + '/' + moduloNumber + '.' + pathParts[2];
    }

    console.log("Requested file: " + req.url);

    if (req.method == 'HEAD') {
        res.send(200, null);
        return;
    }

    if (host) {
        req.headers.host = host;
        req.host = host;
    }

    proxy.web(req, res, {
        target: proxyTarget
    });
});

/*
 * Start server
 */
var server = http.createServer(app);
var port = process.env.PORT || 7000;
server.listen(port);
console.log("Now listening on port " + port);
