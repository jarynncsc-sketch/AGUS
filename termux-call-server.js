// ============================================================
// Termux Anomaly Alert Server
// Run in Termux: node termux-call-server.js
// Requires: pkg install nodejs termux-api -y
// The SIM phone (09060875427) calls the operator number sent by the dashboard.
// ============================================================
var http = require('http');
var { exec } = require('child_process');

var PORT = 8150;

function callPhone(deviceName, reason, targetNumber, callback) {
  if (!targetNumber) { console.warn('No target number for', deviceName); if (callback) callback(new Error('No number')); return; }
  var msg = 'AGUS: ' + deviceName + ' - ' + reason;
  exec('termux-sms-send -n "' + targetNumber + '" "' + msg.replace(/"/g, '\\"') + '"', function(err) {
    if (err) console.error('SMS to', targetNumber, 'failed:', err.message);
    else console.log('SMS sent to', targetNumber, ':', msg);
  });
  exec('termux-telephony-call ' + targetNumber, function(err) {
    if (err) console.error('Call to', targetNumber, 'failed:', err.message);
    else console.log('Calling operator', targetNumber, 'for', deviceName);
    if (callback) callback(err);
  });
}

http.createServer(function(req, res) {
  var url = req.url;
  if (url.startsWith('/alert')) {
    var params = new URLSearchParams(url.includes('?') ? url.split('?')[1] : '');
    var device  = params.get('device')  || 'Unknown';
    var reason  = params.get('reason')  || 'Anomaly detected';
    var number  = params.get('number')  || '';
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' });
    callPhone(device, reason, number, function() {
      res.end('OK');
    });
  } else {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' });
    res.end('AGUS Termux Alert Server running on port ' + PORT);
  }
}).listen(PORT, '0.0.0.0', function() {
  console.log('AGUS Termux Alert Server listening on http://0.0.0.0:' + PORT);
  console.log('SIM phone will call operator numbers per device mapping');
  console.log('Find this phone IP with: ip addr show wlan0 | grep inet');
});
