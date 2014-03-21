// The App
var express = require("express");
var app = express();
var fs = require('fs');
var lazy = require("lazy");
// Simplified HTTP request which follows redirects by default
var request = require('request');
var http = require('http');

app.disable('etag');

// Use static middleware
// app.use(express.static(__dirname + '/static'));

// Logging and setting of 'X-Response-Time' header
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

app.use(function(req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

// Use the router middleware
// app.use(app.router);

app.get('/manifest.mpd', function(req, res) {
    //res.setHeader('Access-Control-Allow-Origin', '*');
    var now = new Date();
    var offset = (now - startDate) / 1000;
    offset -= 10;
    var startTime = dateToString(now);


    console.log("Time: " + offset + " s after start");
    console.log("Manifest request from: " + req.connection.remoteAddress);
    fs.readFile('manifest.mpd', function read(error, data) {
        if (error) {
            res.send(500);
        }
        res.setHeader('Content-Type', 'application/xml');
        res.send(data.toString()
            .split('$StartTime$').join('PT' + offset + 'S')
            .split('$StartNumber$').join(Math.floor(offset / 4))
            .split('$PublishTime$').join(publishTime)
        );
    });
});

app.get('*', function(req, res) {
    console.log("Media request from " + req.connection.remoteAddress + " for " + req.path);
    res.setHeader('Content-Type', 'video/mp4');
    var re = /(.*\/)(\d+)(\.m4s)/;
    var parts = req.path.match(re);
    var path;
    if (parts !== null)
        path = parts[1] + (parts[2] % 65) + parts[3];
    else
        path = req.path;

    var aws_url = "http://lajv.s3-website-eu-west-1.amazonaws.com/envivio" + path;
    var local_url = "http://localhost:8080/dash/envivio" + path;
    var request = http.get(local_url, function(response) {
        console.log("PROXY: " + response.statusCode + " " + path);
        response.pipe(res);
    });
    // var options = {
    //     hostname: 'lajv.s3-website-eu-west-1.amazonaws.com',
    //     port: 80,
    //     path: '/envivio' + path,
    //     method: 'GET'
    // };
    // var request = http.request(options, function(response) {
    //     console.log('AWS status code: ' + response.statusCode);
    //     response.setEncoding('utf8');
    //     response.pipe(res);
    //     response.on('end', function() {
    //         res.send();
    //     });

    // });

    request.on('error', function(error) {
        console.error(error);
        res.send(500);
    });
    // request.end();
});

// Create HTTP server with your app
var http = require("http");
var server = http.createServer(app);
var startDate = new Date();

var dateToString = function(date) {
    var yyyy = date.getFullYear();
    var m = date.getFullYear() + 1;
    var mm = (m < 10 ? '0' + m : m);
    var d = date.getDate();
    var dd = (d < 10 ? '0' + d : d);
    var time = date.toTimeString().substr(0, 8);
    return yyyy + '-' + mm + '-' + dd + 'T' + time;
};

var publishTime = dateToString(startDate);

var port = 7000;
server.listen(port);
console.log("Now listening on port " + port);