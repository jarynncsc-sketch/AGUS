// ============================================================
// Termux Alert Poller — reads alerts from Firebase over mobile data
// The phone runs this 24/7. It polls Firebase every 10 seconds.
// When an alert is found, it SMS + calls the target operator number.
// ============================================================
// Run: node termux-alert-poller.js
// Requires: pkg install nodejs termux-api -y
//
// BUG 19 NOTE: This poller is the authoritative call dispatcher.
// termux-call-server.js handles DIRECT calls from the dashboard (same LAN).
// Do NOT run both for the same device — that will cause duplicate calls.
// Recommended setup: use THIS poller for remote/mobile relay, use
// termux-call-server.js only if dashboard is on the same LAN as the phone.
// ============================================================

var https = require('https');
var fs    = require('fs');
var path  = require('path');
var { exec } = require('child_process');

// ── Your Firebase database URL (must match index.html) ──
var FIREBASE_DATABASE_URL = 'https://cwd-pump-automation-dashboard-default-rtdb.asia-southeast1.firebasedatabase.app';

var POLL_INTERVAL_MS = 10000; // check every 10 seconds

// BUG 22 FIX: persist processed keys to disk so crashes/restarts don't re-process old alerts
var PROCESSED_KEYS_FILE = path.join(__dirname, '.agus_processed_keys.json');
var PROCESSED_KEYS = {};
try {
  PROCESSED_KEYS = JSON.parse(fs.readFileSync(PROCESSED_KEYS_FILE, 'utf8'));
  // Prune keys older than 1 hour on startup
  var cutoff = Date.now() - 3600000;
  Object.keys(PROCESSED_KEYS).forEach(function(k) {
    if (PROCESSED_KEYS[k] < cutoff) delete PROCESSED_KEYS[k];
  });
  console.log('Loaded', Object.keys(PROCESSED_KEYS).length, 'processed key(s) from disk');
} catch(e) {
  PROCESSED_KEYS = {};
}

function _saveProcessedKeys() {
  try { fs.writeFileSync(PROCESSED_KEYS_FILE, JSON.stringify(PROCESSED_KEYS)); } catch(e) {}
}

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

function firebaseDelete(fbPath, callback) {
  var url = FIREBASE_DATABASE_URL + fbPath + '.json';
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
    var changed = false;
    Object.keys(data).forEach(function(key) {
      if (PROCESSED_KEYS[key]) return; // BUG 22 FIX: persisted dedup
      PROCESSED_KEYS[key] = Date.now();
      changed = true;
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
    if (changed) _saveProcessedKeys();
  });
}

console.log('AGUS Alert Poller started — polling every ' + (POLL_INTERVAL_MS/1000) + 's');
console.log('Firebase:', FIREBASE_DATABASE_URL);
console.log('NOTE: Run EITHER this poller OR termux-call-server.js — not both (BUG 19)');
pollAlerts();
setInterval(pollAlerts, POLL_INTERVAL_MS);

