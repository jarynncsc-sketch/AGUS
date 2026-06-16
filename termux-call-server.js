// ============================================================
// Termux Anomaly Alert Server
// Run in Termux: node termux-call-server.js
// Requires: pkg install nodejs termux-api -y
// ============================================================
var http = require('http');
var { exec } = require('child_process');

var PORT = 8150;
var PHONE_NUMBER = process.env.ALERT_NUMBER || '+1234567890'; // Change or set env

function callPhone(deviceName, reason, callback) {
  // Send SMS first with details
  var msg = 'AGUS ALERT: ' + deviceName + ' - ' + reason;
  exec('termux-sms-send -n "' + PHONE_NUMBER + '" "' + msg.replace(/"/g, '\\"') + '"', function(err) {
    if (err) console.error('SMS failed:', err.message);
    else console.log('SMS sent:', msg);
  });
  // Then dial
  exec('termux-telephony-call ' + PHONE_NUMBER, function(err) {
    if (err) console.error('Call failed:', err.message);
    else console.log('Calling', PHONE_NUMBER);
    if (callback) callback(err);
  });
}

http.createServer(function(req, res) {
  var url = req.url;
  if (url.startsWith('/alert')) {
    var params = new URLSearchParams(url.includes('?') ? url.split('?')[1] : '');
    var device = params.get('device') || 'Unknown';
    var reason = params.get('reason') || 'Anomaly detected';
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' });
    callPhone(device, reason, function() {
      res.end('OK');
    });
  } else {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' });
    res.end('Termux Alert Server running on port ' + PORT);
  }
}).listen(PORT, '127.0.0.1', function() {
  console.log('AGUS Termux Alert Server listening on http://127.0.0.1:' + PORT);
  console.log('Alert number:', PHONE_NUMBER);
  console.log('Set env ALERT_NUMBER to change. Example:');
  console.log('  ALERT_NUMBER="+639123456789" node termux-call-server.js');
});
