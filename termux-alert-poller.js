// ============================================================
// Termux Alert Poller — reads alerts from Firebase over mobile data
// The phone runs this 24/7. It polls Firebase every 10 seconds.
// When an alert is found, it SMS + calls the target operator number.
// ============================================================
// Run: node termux-alert-poller.js
// Requires: pkg install nodejs termux-api -y
// ============================================================

var https = require('https');
var { exec } = require('child_process');

// ── Your Firebase database URL (must match index.html line 2412) ──
var FIREBASE_DATABASE_URL = 'https://cwd-pump-automation-dashboard-default-rtdb.asia-southeast1.firebasedatabase.app';

var POLL_INTERVAL_MS = 10000; // check every 10 seconds
var PROCESSED_KEYS = {}; // avoid re-processing

function firebaseGet(path, callback) {
  var url = FIREBASE_DATABASE_URL + path + '.json';
  https.get(url, function(res) {
    var body = '';
    res.on('data', function(chunk) { body += chunk; });
    res.on('end', function() {
      try { callback(null, JSON.parse(body)); }
      catch(e) { callback(e, null); }
    });
  }).on('error', function(err) { callback(err, null); });
}

function firebaseDelete(path, callback) {
  var url = FIREBASE_DATABASE_URL + path + '.json';
  var req = https.request(url, { method: 'DELETE' }, function(res) {
    if (callback) callback(null);
  });
  req.on('error', function(err) { if (callback) callback(err); });
  req.end();
}

function callOperator(device, reason, number) {
  if (!number) { console.log('No target number, skipping call'); return; }
  var msg = 'AGUS: ' + device + ' - ' + reason;
  exec('termux-sms-send -n "' + number + '" "' + msg.replace(/"/g, '\\"') + '"', function(err) {
    if (err) console.error('SMS failed:', err.message);
    else console.log('SMS sent to', number, ':', msg);
  });
  exec('termux-telephony-call ' + number, function(err) {
    if (err) console.error('Call failed:', err.message);
    else console.log('Calling', number, 'for', device);
  });
}

function pollAlerts() {
  firebaseGet('/alertQueue', function(err, data) {
    if (err) { console.error('Poll error:', err.message); return; }
    if (!data) return;
    Object.keys(data).forEach(function(key) {
      if (PROCESSED_KEYS[key]) return;
      PROCESSED_KEYS[key] = true;
      var alert = data[key];
      if (!alert || !alert.number) return;
      console.log('Alert:', alert.device, alert.reason, '→', alert.number);
      callOperator(alert.device, alert.reason, alert.number);
      // Delete from Firebase after processing
      firebaseDelete('/alertQueue/' + key, function(err) {
        if (err) console.error('Delete failed:', err.message);
        else console.log('Cleared alert:', key);
      });
    });
  });
}

console.log('AGUS Alert Poller started — polling every ' + (POLL_INTERVAL_MS/1000) + 's');
console.log('Firebase:', FIREBASE_DATABASE_URL);
pollAlerts();
setInterval(pollAlerts, POLL_INTERVAL_MS);
