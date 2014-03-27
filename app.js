// The App
var express = require("express");
var app = express();
var fs = require('fs');
var lazy = require("lazy");
// Simplified HTTP request which follows redirects by default
var request = require('request');
var http = require('http');
var httpProxy = require('http-proxy');

app.disable('etag');

/*
 * Initialization
 */
var availTime = new Date(new Date() - 60 * 1000); // 60 seconds ago
var proxy = httpProxy.createProxyServer({
    target: 'http://localhost:8080'
});

/*
 * Constants
 */
var segDur = 4; // In seconds
var timeShiftBuffer = 20; // In seconds
var suggestedPresentationDelay = 20; // In seconds
var videoTimescale = 90000;
var audioTimescale = 48000;

/*
 * Calculated values
 */
var availableSegmentsTime = timeShiftBuffer + suggestedPresentationDelay;
// var minBufferTime = availableSegmentsTime; // Buffer as much as possible
// Uncomment following line if we're having problems
var minBufferTime = suggestedPresentationDelay; // Normal buffering
var numAvailSegs = Math.ceil(availableSegmentsTime / segDur);
var minUpdateTime = segDur;
var videoSegDur = segDur * videoTimescale;
var audioSegDur = segDur * audioTimescale;

/*
 * Manifest manipulations
 */
var manifest = fs.readFileSync('live-manifest.mpd').toString();
manifest = manifest.split("$AvailabilityStartTime$").join(availTime.toISOString());
manifest = manifest.split("$MaxSegmentDuration$").join(segDur);
manifest = manifest.split("$MinimumUpdatePeriod$").join(minUpdateTime);
manifest = manifest.split("$MinBufferTime$").join(minBufferTime);
manifest = manifest.split("$TimeShiftBufferDepth$").join(timeShiftBuffer);
manifest = manifest.split("$SuggestedPresentationDelay$").join(suggestedPresentationDelay);
manifest = manifest.split("$VideoTimescale$").join(videoTimescale);
manifest = manifest.split("$AudioTimescale$").join(audioTimescale);
// Add video segments
var videoSegments = '<S t="$VideoStart$" d="360000" />\n';
for (var i = 1; i < numAvailSegs; i++) {
    videoSegments += '          <S d="360000" />\n';
}
manifest = manifest.split("$VideoSegments$").join(videoSegments);
// Add audio segments
var audioSegments = '<S t="$AudioStart$" d="192000" />\n';
for (var i = 1; i < numAvailSegs; i++) {
    audioSegments += '          <S d="192000" />\n';
}
manifest = manifest.split("$AudioSegments$").join(audioSegments);

console.log("Manifest template generated:\n\n" + manifest + "\n\n");


// Use static middleware
// app.use(express.static(__dirname + '/static'));

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
    next();
});

// Use the router middleware
// app.use(app.router);


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

app.get('/dash/live-envivio/live-manifest.mpd', function(req, res) {
    console.log("Manifest request from: " + req.connection.remoteAddress);
    res.setHeader('Content-Type', 'application/xml');
    var info = getCurrentInfo();
    res.send(manifest
        .split('$PublishTime$').join(info.now.toISOString())
        .split('$VideoStart$').join(info.videoOffset)
        .split('$AudioStart$').join(info.audioOffset)
    );
});

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

    var regexpTime = /\/(\d+)\./;
    var time = req.path.match(regexpTime)[1];


    var seg = time / timescale / segDur;
    console.log("Segment: " + seg);

    if (seg > info.last) {
        console.log("Requesting a segment which is not yet available");
        res.send(404, "Segment is not yet available");
        return;
    }

    proxy.web(req, res, {
        target: 'http://localhost:8080'
    });
    // res.setHeader('Content-Type', 'video/mp4');
    // var re = /(.*\/)(\d+)(\.m4s)/;
    // var parts = req.path.match(re);
    // var path;
    // // if (parts !== null)
    // //     path = parts[1] + (parts[2] % 65) + parts[3];
    // // else
    // path = req.path;

    // var aws_url = "http://lajv.s3-website-eu-west-1.amazonaws.com/envivio" + path;
    // var local_url = "http://localhost:8080/dash/live-envivio" + path;
    // console.log("Fetching " + local_url);
    // var request = http.get(local_url, function(response) {
    //     console.log("PROXY: " + response.statusCode + " " + path);
    //     response.pipe(res);
    // });
    // // var options = {
    // //     hostname: 'lajv.s3-website-eu-west-1.amazonaws.com',
    // //     port: 80,
    // //     path: '/envivio' + path,
    // //     method: 'GET'
    // // };
    // // var request = http.request(options, function(response) {
    // //     console.log('AWS status code: ' + response.statusCode);
    // //     response.setEncoding('utf8');
    // //     response.pipe(res);
    // //     response.on('end', function() {
    // //         res.send();
    // //     });

    // // });

    // request.on('error', function(error) {
    //     console.error(error);
    //     res.send(500);
    // });
    // request.end();
});

// Create HTTP server with your app
var http = require("http");
var server = http.createServer(app);
var startDate = new Date();

var dateToString = function(date) {
    var yyyy = date.getFullYear();
    var m = date.getMonth() + 1;
    var mm = (m < 10 ? '0' + m : m);
    var d = date.getDate();
    var dd = (d < 10 ? '0' + d : d);
    var time = date.toTimeString().substr(0, 8);
    return yyyy + '-' + mm + '-' + dd + 'T' + time;
};

var publishTime = startDate.toISOString(); // dateToString(startDate);

var port = 7000;
server.listen(port);
console.log("Now listening on port " + port);
