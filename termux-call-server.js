// ============================================================
// Termux Anomaly Alert Server — port 8150
// Run in Termux: node termux-call-server.js
// Requires: pkg install nodejs termux-api -y
//
// BUG 17 FIX: Dashboard (index.html) now calls port 8150 /alert?device=...&reason=...&number=...
//   Old dashboard used 7373/call — this server now handles BOTH routes for compatibility.
// BUG 19 FIX: Per-call dedup prevents duplicate calls within 60s for same device+reason.
// NOTE: Use EITHER this server (LAN direct) OR termux-alert-poller.js (Firebase relay) —
//   running both for the same alarm causes duplicate calls.
// ============================================================
var http = require('http');
var { exec } = require('child_process');

var PORT = 8150;

// BUG 19 FIX: in-memory dedup keyed by device+reason, 60s cooldown
var _recentCalls = {}; // key -> timestamp
var CALL_DEDUP_MS = 60000;

function _isDuplicate(device, reason) {
  var key = device + ':' + reason;
  var last = _recentCalls[key] || 0;
  if (Date.now() - last < CALL_DEDUP_MS) return true;
  _recentCalls[key] = Date.now();
  return false;
}

function callPhone(deviceName, reason, targetNumber, callback) {
  if (!targetNumber) {
    console.warn('No target number for', deviceName);
    if (callback) callback(new Error('No number'));
    return;
  }
  // BUG 19 FIX: dedup check
  if (_isDuplicate(deviceName, reason)) {
    console.log('[DEDUP] Skipping duplicate call for', deviceName, reason, '(within 60s)');
    if (callback) callback(null);
    return;
  }
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
  var corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' };

  // /alert?device=...&reason=...&number=...  (ai.js + new dashboard path)
  if (url.startsWith('/alert')) {
    var params = new URLSearchParams(url.includes('?') ? url.split('?')[1] : '');
    var device = params.get('device') || 'Unknown';
    var reason = params.get('reason') || 'Anomaly detected';
    var number = params.get('number') || '';
    res.writeHead(200, corsHeaders);
    callPhone(device, reason, number, function() { res.end('OK'); });

  // BUG 17 FIX: /call?number=...  (old dashboard path — now redirected here)
  } else if (url.startsWith('/call')) {
    var params2 = new URLSearchParams(url.includes('?') ? url.split('?')[1] : '');
    var number2 = params2.get('number') || '';
    res.writeHead(200, corsHeaders);
    if (number2 && number2 !== 'test') {
      callPhone('AGUS', 'Alarm', number2, function() { res.end('OK'); });
    } else {
      res.end('OK'); // health check or test ping
    }

  // Health/root
  } else {
    res.writeHead(200, corsHeaders);
    res.end('AGUS Termux Alert Server running on port ' + PORT);
  }
}).listen(PORT, '0.0.0.0', function() {
  console.log('AGUS Termux Alert Server listening on http://0.0.0.0:' + PORT);
  console.log('Routes: /alert?device=&reason=&number= (primary), /call?number= (legacy compat)');
  console.log('Find this phone IP with: ip addr show wlan0 | grep inet');
});
