// ============================================================
// Module 1: Enhanced Anomaly Detection (adaptive EWMA + trend-aware)
// ============================================================
var ANOMALY_WINDOW = 30;
var anomalyState = (function(){
  try { return JSON.parse(localStorage.getItem('agus_anomaly_state') || '{}'); } catch(e) { return {}; }
})();
function _saveAnomalyState() {
  try {
    var snap = {};
    Object.keys(anomalyState).forEach(function(k) {
      var s = anomalyState[k];
      snap[k] = { values: s.values.slice(-20), ema: s.ema, emaVariance: s.emaVariance,
        alpha: s.alpha, prevValue: s.prevValue, trendCount: s.trendCount,
        baseline: s.baseline, baselineStd: s.baselineStd };
    });
    localStorage.setItem('agus_anomaly_state', JSON.stringify(snap));
  } catch(e) {}
}
function detectAnomaly(deviceName, value) {
  if (isNaN(value)) return { anomaly: false, zscore: 0, direction: null, type: null };
  if (!anomalyState[deviceName]) {
    anomalyState[deviceName] = {
      values: [], ema: null, emaVariance: null,
      alpha: 0.15,  // EWMA smoothing factor
      prevValue: null, trendCount: 0,
      baseline: null, baselineStd: null
    };
  }
  var s = anomalyState[deviceName];
  s.values.push(value);
  if (s.values.length > ANOMALY_WINDOW) s.values.shift();
  var mean = s.values.reduce(function(a,b){return a+b;},0)/s.values.length;
  var std = Math.sqrt(s.values.reduce(function(sq,v){return sq+Math.pow(v-mean,2);},0)/s.values.length) || 1;
  if (s.baseline === null) { s.baseline = mean; s.baselineStd = std; }
  else { s.baseline = s.baseline * 0.9 + mean * 0.1; s.baselineStd = s.baselineStd * 0.9 + std * 0.1; }
  var zscore = Math.abs((value - mean) / (std || 1));
  if (s.ema === null) s.ema = value;
  else s.ema = s.alpha * value + (1 - s.alpha) * s.ema;
  if (s.emaVariance === null) s.emaVariance = 0;
  else s.emaVariance = s.alpha * Math.pow(value - s.ema, 2) + (1 - s.alpha) * s.emaVariance;
  var emaStd = Math.sqrt(s.emaVariance) || 1;
  var emaZ = Math.abs((value - s.ema) / emaStd);
  var isTrend = (s.prevValue !== null) ? (value > s.prevValue ? 1 : (value < s.prevValue ? -1 : 0)) : 0;
  s.trendCount = isTrend === 1 ? Math.min(s.trendCount + 1, 10) : (isTrend === -1 ? Math.max(s.trendCount - 2, -10) : 0);
  s.prevValue = value;
  var anomaly = (zscore > 2.5 || emaZ > 3.0 || Math.abs(s.trendCount) >= 5);
  var direction = s.trendCount > 2 ? 'up' : (s.trendCount < -2 ? 'down' : null);
  var type = zscore > 2.5 ? 'spike' : (Math.abs(s.trendCount) >= 5 ? 'trend' : (emaZ > 3.0 ? 'level_shift' : null));
  _saveAnomalyState();
  return { anomaly: anomaly, zscore: Math.max(zscore, emaZ), direction: direction, type: type };
}

function injectAnomalyBadge(li, deviceName, reading, isReservoir) {
  var result = detectAnomaly(deviceName + (isReservoir ? ':level' : ':pressure'), parseFloat(reading));
  if (result && result.anomaly) {
    var existing = li.querySelector('.ai-anomaly-badge');
    if (existing) existing.remove();
    var badge = document.createElement('span');
    badge.className = 'ai-anomaly-badge';
    badge.style.cssText = 'display:inline-block;margin-left:6px;padding:1px 7px;border-radius:10px;font-size:9px;font-weight:800;color:#fff;background:' + (result.direction==='up'?'#ef4444':'#f97316') + ';';
    badge.textContent = (result.type==='trend'?'⚡':result.type==='level_shift'?'⬆':'⚠') + ' ' + result.zscore.toFixed(1) + 'σ';
    var nameEl = li.querySelector('span');
    if (nameEl) nameEl.parentNode.insertBefore(badge, nameEl.nextSibling);
  }
  // Also show Isolation Forest badge if available
  var ifScore = getIFScore({ device: deviceName, pressure: reading, flow: 0, power: 0, voltage: 0, level: 0, relay: 0 });
  if (ifScore !== null && ifScore > 0.5) {
    var ifBadge = li.querySelector('.ai-if-badge');
    if (!ifBadge) {
      ifBadge = document.createElement('span');
      ifBadge.className = 'ai-if-badge';
      ifBadge.style.cssText = 'display:inline-block;margin-left:4px;padding:1px 7px;border-radius:10px;font-size:9px;font-weight:800;color:#fff;background:' + (ifScore>0.65?'#7c3aed':'#a78bfa') + ';cursor:help;';
      ifBadge.title = 'Isolation Forest anomaly: ' + (ifScore*100).toFixed(0) + '%';
      ifBadge.textContent = '🌲 ' + (ifScore*100).toFixed(0) + '%';
      var nameEl2 = li.querySelector('span');
      if (nameEl2) nameEl2.parentNode.insertBefore(ifBadge, nameEl2.nextSibling);
    }
  } else {
    var oldIf = li.querySelector('.ai-if-badge');
    if (oldIf) oldIf.remove();
  }
}

// ============================================================
// Module 1b: Isolation Forest — unsupervised anomaly detection
// ============================================================
function IsolationForest(trees, sampleSize) {
  this.trees = trees || 50;
  this.sampleSize = sampleSize || 64;
  this.forest = [];
  this.dataSize = 0;
}
IsolationForest.prototype.save = function() {
  return JSON.stringify({ forest: this.forest, dataSize: this.dataSize, trees: this.trees, sampleSize: this.sampleSize });
};
IsolationForest.load = function(str) {
  var o = JSON.parse(str);
  var f = new IsolationForest(o.trees, o.sampleSize);
  f.forest = o.forest; f.dataSize = o.dataSize; return f;
};
IsolationForest.prototype._randBetween = function(a, b) { return a + Math.random() * (b - a); };
IsolationForest.prototype._randInt = function(a, b) { return Math.floor(this._randBetween(a, b)); };
IsolationForest.prototype._cFactor = function(n) {
  if (n <= 1) return 1;
  var h = Math.log(n - 1) + 0.5772156649;
  return 2 * h - (2 * (n - 1) / n);
};
IsolationForest.prototype._buildTree = function(data, depth, maxDepth) {
  if (depth >= maxDepth || data.length <= 1) {
    return { type: 'leaf', size: data.length };
  }
  var dims = data[0].length;
  var q = this._randInt(0, dims);
  var minVal = data[0][q], maxVal = data[0][q];
  for (var i = 1; i < data.length; i++) {
    if (data[i][q] < minVal) minVal = data[i][q];
    if (data[i][q] > maxVal) maxVal = data[i][q];
  }
  if (minVal === maxVal) return { type: 'leaf', size: data.length };
  var split = this._randBetween(minVal, maxVal);
  var left = [], right = [];
  for (var j = 0; j < data.length; j++) {
    if (data[j][q] < split) left.push(data[j]); else right.push(data[j]);
  }
  if (left.length === 0 || right.length === 0) return { type: 'leaf', size: data.length };
  return {
    type: 'node', q: q, split: split,
    left: this._buildTree(left, depth + 1, maxDepth),
    right: this._buildTree(right, depth + 1, maxDepth)
  };
};
IsolationForest.prototype._pathLength = function(point, tree, depth) {
  if (tree.type === 'leaf') return depth + this._cFactor(tree.size);
  if (point[tree.q] < tree.split) return this._pathLength(point, tree.left, depth + 1);
  return this._pathLength(point, tree.right, depth + 1);
};
IsolationForest.prototype.train = function(data) {
  if (!data || data.length < 4) return;
  this.dataSize = data.length;
  this.forest = [];
  var ss = Math.min(this.sampleSize, data.length);
  var maxDepth = Math.ceil(Math.log2(ss));
  for (var t = 0; t < this.trees; t++) {
    var sample = [];
    var used = {};
    for (var i = 0; i < ss; i++) {
      var idx;
      do { idx = this._randInt(0, data.length); } while (used[idx]);
      used[idx] = true;
      sample.push(data[idx]);
    }
    this.forest.push(this._buildTree(sample, 0, maxDepth));
  }
};
IsolationForest.prototype.score = function(point) {
  if (this.forest.length === 0) return 0.5;
  var avgPath = 0;
  for (var t = 0; t < this.forest.length; t++) avgPath += this._pathLength(point, this.forest[t], 0);
  avgPath /= this.forest.length;
  var c = this._cFactor(this.dataSize);
  return Math.pow(2, -avgPath / c);
};

// ============================================================
// Module 1c: Persistent Isolation Forest — auto-trains on pump data
// ============================================================
var IF_TRAIN_INTERVAL = 5;  // retrain every N dashboard updates
var _ifUpdateCounter = 0;
var ifAnomalyModel = (function() {
  try {
    var saved = localStorage.getItem('agus_iforest');
    if (saved) return IsolationForest.load(saved);
  } catch(e) {}
  return new IsolationForest(30, 40);
})();
function trainIFModel(devices) {
  if (!devices || devices.length < 3) return;
  _ifUpdateCounter++;
  if (_ifUpdateCounter > 1 && _ifUpdateCounter % IF_TRAIN_INTERVAL !== 0) return;
  var features = [];
  devices.forEach(function(d) {
    var p = parseFloat(d.pressure) || 0;
    var f = parseFloat(d.flow) || 0;
    var w = (parseFloat(d.power) || 0) / 500;
    var v = (parseFloat(d.voltage) || 0) / 100;
    var l = (parseFloat(d.level) || 0) / 10;
    var r = d.relay == 1 || d.relay === '1' ? 1 : 0;
    if (p || f || w || v || l) {
      features.push([p, f, w, v, l, r]);
    }
  });
  if (features.length >= 4) {
    ifAnomalyModel.train(features);
    try { localStorage.setItem('agus_iforest', ifAnomalyModel.save()); } catch(e) {}
  }
}
function getIFScore(device) {
  if (!device || ifAnomalyModel.forest.length === 0) return null;
  var p = parseFloat(device.pressure) || 0;
  var f = parseFloat(device.flow) || 0;
  var w = (parseFloat(device.power) || 0) / 500;
  var v = (parseFloat(device.voltage) || 0) / 100;
  var l = (parseFloat(device.level) || 0) / 10;
  var r = device.relay == 1 || device.relay === '1' ? 1 : 0;
  if (!p && !f && !w && !v && !l) return null;
  return ifAnomalyModel.score([p, f, w, v, l, r]);
}

// ============================================================
// Module 1d: Sigmoid Health Scoring
// ============================================================
function sigmoid(x, midpoint, steepness) {
  return 1 / (1 + Math.exp(-steepness * (x - midpoint)));
}
function computeHealthScore(onlineRatio, faultRatio, avgAnomalyScore, maintenanceScore) {
  var base = sigmoid(onlineRatio, 0.7, 10) * 100;
  var penalty = (1 - sigmoid(faultRatio, 0.1, 20)) * 100;
  var anomalyScore = Math.max(0, 100 - (avgAnomalyScore || 0) * 100);
  var maintScore = maintenanceScore !== undefined ? Math.max(0, 100 - maintenanceScore) : 100;
  var raw = base * 0.35 + penalty * 0.30 + anomalyScore * 0.20 + maintScore * 0.15;
  return Math.round(Math.min(100, Math.max(0, raw)));
}

// ============================================================
// Module 2: Predictive Maintenance Scoring
// ============================================================
var maintenanceData = {};
function trackMaintenanceEvent(deviceName, d) {
  if (!maintenanceData[deviceName]) maintenanceData[deviceName] = { faultCount: 0, onSeconds: 0, voltSags: 0, lastScore: 0, lastStatus: null };
  var m = maintenanceData[deviceName];
  if (d.fault) m.faultCount++;
  if (d.power && d.power > 4000) m.faultCount += 1;
  if (d.voltage && d.voltage < 200) m.voltSags++;
  if (d.relay==1||d.relay==='1'||d.relay===true) m.onSeconds += 60;
  m.lastStatus = d.status||'unknown';
}
function getMaintenanceLabel(score) {
  return score <= 25 ? 'GOOD' : score <= 50 ? 'FAIR' : score <= 75 ? 'WARN' : 'CRITICAL';
}
function buildMaintenanceBadge(deviceName) {
  var m = maintenanceData[deviceName];
  if (!m || (m.faultCount < 2 && m.voltSags < 2 && m.onSeconds < 7200)) return '';
  var score = Math.min(100, Math.round(m.faultCount * 8 + m.voltSags * 6 + m.onSeconds / 7200 * 15));
  var label = getMaintenanceLabel(score);
  var color = score <= 25 ? '#22c55e' : score <= 50 ? '#f97316' : score <= 75 ? '#ea580c' : '#ef4444';
  return '<div style="margin-top:8px;padding:8px 12px;background:'+color+'18;border-left:3px solid '+color+';border-radius:6px;font-size:12px;">'
    + '<span style="font-weight:700;color:'+color+';">🔧 Maintenance: '+label+' ('+score+'/100)</span>'
    + '<span style="color:#475569;margin-left:6px;">Faults:'+m.faultCount+' Sags:'+m.voltSags+' Run:'+Math.round(m.onSeconds/60)+'m</span>'
    + '<button onclick="resetMaintScore(\''+deviceName+'\')" style="margin-left:8px;padding:1px 8px;background:transparent;border:1px solid '+color+';border-radius:4px;color:'+color+';cursor:pointer;font-size:10px;">Reset</button></div>';
}
function updateMaintenanceScore(devices) {
  devices.forEach(function(d) { trackMaintenanceEvent(d.device, d); });
}
function resetMaintScore(deviceName) {
  if (maintenanceData[deviceName]) delete maintenanceData[deviceName];
  if (window.updateDashboard) window.updateDashboard();
}

// ============================================================
// Module 3: AI Demand Forecasting (WMA + hourly seasonality)
// ============================================================
function computeForecast(rows, key) {
  if (!rows || rows.length < 24) return [];
  var vals = rows.map(function(r){return parseFloat(r[key]);}).filter(function(v){return !isNaN(v)&&v!=null;});
  if (vals.length < 24) return [];
  var windowSize = Math.min(48, vals.length);
  var recent = vals.slice(-windowSize);
  var wma = [];
  for (var i = 0; i < recent.length; i++) {
    var sum = 0, wSum = 0;
    for (var j = Math.max(0, i-12); j <= i; j++) {
      var w = j - Math.max(0, i-12) + 1;
      sum += recent[j] * w; wSum += w;
    }
    wma.push(wSum ? sum / wSum : recent[i]);
  }
  var seasonalPattern = [];
  var periods = Math.min(24, windowSize);
  for (var h = 0; h < periods; h++) {
    var hourVals = [];
    for (var k = h; k < wma.length; k += periods) hourVals.push(wma[k]);
    if (hourVals.length) {
      var avg = hourVals.reduce(function(a,b){return a+b;},0)/hourVals.length;
      var overallAvg = wma.reduce(function(a,b){return a+b;},0)/wma.length || 1;
      seasonalPattern.push(avg / overallAvg);
    } else seasonalPattern.push(1);
  }
  var lastVal = wma[wma.length - 1];
  var forecast = [];
  var steps = Math.min(periods, 24);
  for (var f = 0; f < steps; f++) {
    var factor = seasonalPattern[f % seasonalPattern.length] || 1;
    forecast.push(parseFloat((lastVal * factor).toFixed(2)));
  }
  var allProjected = [];
  var projVal = lastVal;
  for (var p = 0; p < steps; p++) {
    var factor = seasonalPattern[p % seasonalPattern.length] || 1;
    allProjected.push(parseFloat((projVal * factor).toFixed(2)));
    projVal = allProjected[p];
  }
  for (var d = 0; d < vals.length - steps; d++) allProjected.unshift(null);
  return allProjected;
}

function injectForecastDataset() {
  if (typeof myChart === 'undefined' || !myChart) return;
  var data = myChart.data;
  if (!data || !data.datasets) return;
  var key = 'pressure';
  var existingIdx = -1;
  data.datasets.forEach(function(ds, i) { if (ds.label === 'AI Forecast') existingIdx = i; });
  if (existingIdx >= 0) return;
  var forecast = computeForecast(data, key);
  if (!forecast || forecast.length < 5) return;
  myChart.data.datasets.push({
    label: 'AI Forecast',
    data: forecast,
    borderColor: 'rgba(245,158,11,0.9)',
    backgroundColor: 'rgba(245,158,11,0.07)',
    borderWidth: 2.5,
    borderDash: [7, 4],
    pointRadius: 0,
    pointHoverRadius: 5,
    fill: true,
    tension: 0.4,
    spanGaps: false,
    yAxisID: 'yLeft'
  });
  myChart.update('none');
}

// ============================================================
// AI API CONFIGURATION (configurable via settings UI)
// ============================================================
var AI_CACHE = {};

// ── AI Chat utilities (called from Block 2 and 3) ──
var aiChatHistory = [];
function addAIChatMessage(text, role) {
  var container = document.getElementById('ai-chat-messages');
  if (!container) return null;
  var div = document.createElement('div');
  div.className = 'ai-msg ai-msg-' + role;
  div.textContent = text || '';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}
function _safeMin(arr) { return arr.length ? Math.min.apply(null, arr) : null; }
function _safeMax(arr) { return arr.length ? Math.max.apply(null, arr) : null; }
function _safeAvg(arr) { return arr.length ? arr.reduce(function(a,b){return a+b;},0)/arr.length : null; }
function _findDev(devs, field, val) { return devs.find(function(d){ return parseFloat(d[field])===val; }); }
function _pick(arr) { return arr.length ? arr[0] : null; }

function buildAISystemContext(devices) {
  if (!devices || !devices.length) return 'AGUS SCADA assistant with no device data available.';
  var online = devices.filter(function(d){ return (d.status||'').toLowerCase()==='online'; }).length;
  var fault = devices.filter(function(d){ return (d.status||'').toLowerCase()==='fault'||d.button; }).length;
  var offline = devices.filter(function(d){ return (d.status||'').toLowerCase()==='offline'; }).length;
  var pres   = devices.map(function(d){return parseFloat(d.pressure);}).filter(function(v){return !isNaN(v)&&v>0;});
  var flows  = devices.map(function(d){return parseFloat(d.flow);}).filter(function(v){return !isNaN(v)&&v>0;});
  var pwrs   = devices.map(function(d){return parseFloat(d.power);}).filter(function(v){return !isNaN(v)&&v>0;});
  var volts  = devices.map(function(d){return parseFloat(d.voltage);}).filter(function(v){return !isNaN(v)&&v>0;});
  var amps   = devices.map(function(d){return parseFloat(d.current);}).filter(function(v){return !isNaN(v)&&v>0;});
  var enrg   = devices.map(function(d){return parseFloat(d.energy);}).filter(function(v){return !isNaN(v)&&v>0;});
  var lvls   = devices.map(function(d){return parseFloat(d.level);}).filter(function(v){return !isNaN(v)&&v>0;});
  var pumps  = devices.filter(function(d){ var n=(d.device||'').toLowerCase(); return n.includes('pumping station')||n.includes('pump')||n.includes('booster')||(/^ps[\s-]?\d/).test(n); });
  var resvrs = devices.filter(function(d){return (d.type||'').toLowerCase()==='reservoir'||((d.device||'').toLowerCase().includes('reservoir')&&(d.type||'').toLowerCase()!=='pressure');});
  var running = devices.filter(function(d){ return d.relay==1||d.relay==='1'||d.relay===true; }).length;
  var lines = devices.map(function(d) {
    var parts = [d.device + ' (' + (d.type||'Unknown') + ')'];
    parts.push('Status:' + (d.status||'?'));
    if (d.pressure) parts.push('Psi:' + d.pressure);
    if (d.flow) parts.push('Flow:' + d.flow);
    if (d.power) parts.push('W:' + d.power);
    if (d.voltage) parts.push('V:' + d.voltage);
    if (d.current) parts.push('A:' + d.current);
    if (d.energy) parts.push('kWh:' + d.energy);
    if (d.level) parts.push('Lvl:' + d.level);
    if (d.relay!=null) parts.push('Relay:' + (d.relay==1||d.relay==='1'?'ON':'OFF'));
    if (d.button) parts.push('FAULT');
    if (d.firmware) parts.push('FW:' + d.firmware);
    if (d.latitude) parts.push('GPS:' + d.latitude + ',' + d.longitude);
    if (d.minPsi) parts.push('Range:' + d.minPsi + '-' + d.maxPsi + 'psi');
    if (d.lastToggledBy) parts.push('ToggledBy:' + d.lastToggledBy);
    return parts.join(' | ');
  });
  var summary = devices.length + ' total (' + online + ' online, ' + fault + ' fault, ' + offline + ' offline). '
    + pumps.length + ' pumps (' + running + ' running), ' + resvrs.length + ' reservoirs.';
  if (pres.length) summary += ' Pressure ' + _safeMin(pres).toFixed(1) + '-' + _safeMax(pres).toFixed(1) + ' psi (avg ' + _safeAvg(pres).toFixed(1) + ').';
  if (flows.length) summary += ' Flow ' + _safeMin(flows).toFixed(1) + '-' + _safeMax(flows).toFixed(1) + ' L/s (total ' + flows.reduce(function(a,b){return a+b;},0).toFixed(1) + ').';
  if (pwrs.length) summary += ' Power ' + _safeMin(pwrs).toFixed(0) + '-' + _safeMax(pwrs).toFixed(0) + ' W (total ' + pwrs.reduce(function(a,b){return a+b;},0).toFixed(0) + ').';
  if (volts.length) summary += ' Voltage ' + _safeMin(volts).toFixed(0) + '-' + _safeMax(volts).toFixed(0) + ' V.';
  if (lvls.length) summary += ' Water level ' + _safeMin(lvls).toFixed(1) + '-' + _safeMax(lvls).toFixed(1) + ' m.';
  return 'You are an AI assistant for the AGUS water utility SCADA system.\n'
    + 'System snapshot:\n' + summary + '\n'
    + 'Each device line format: Name (Type) | Status | Psi | Flow | W | V | A | kWh | Lvl | Relay | Fault | FW | GPS | PressureRange | ToggledBy\n'
    + 'Devices:\n' + lines.join('\n');
}

function _answerSpecificDevice(q, devs) {
  var parts = q.replace(/[^a-z0-9\s-]/g,'').split(/\s+/);
  var name = null;
  for (var pi = 0; pi < parts.length; pi++) {
    var candidate = parts[pi];
    if (candidate.length < 3) continue;
    var match = devs.find(function(d){ return (d.device||'').toLowerCase().includes(candidate); });
    if (match) { name = match.device; break; }
  }
  if (!name) return null;
  // check for "show", "tell", "what is", "details" before the name
  var d = devs.find(function(x){return x.device===name;});
  if (!d) return null;
  var lines = [];
  lines.push('Device: ' + d.device + ' (' + (d.type||'N/A') + ')');
  lines.push('Status: ' + (d.status||'N/A') + (d.button?' [FAULT]':'') + (d.relay!=null?' — Relay: ' + (d.relay==1||d.relay==='1'||d.relay===true?'● ON':'○ OFF'):''));
  if (d.pressure!=null) lines.push('Pressure: ' + d.pressure + ' psi');
  if (d.flow!=null) lines.push('Flow: ' + d.flow + ' L/s');
  if (d.power!=null) lines.push('Power: ' + d.power + ' W');
  if (d.voltage!=null) lines.push('Voltage: ' + d.voltage + ' V');
  if (d.current!=null) lines.push('Current: ' + d.current + ' A');
  if (d.energy!=null) lines.push('Energy: ' + d.energy + ' kWh');
  if (d.level!=null) lines.push('Water Level: ' + d.level + ' m');
  if (d.firmware) lines.push('Firmware: ' + d.firmware);
  if (d.latitude) lines.push('GPS: ' + d.latitude + ', ' + d.longitude);
  if (d.minPsi) lines.push('Pressure Range: ' + d.minPsi + ' - ' + d.maxPsi + ' psi');
  if (d.minLevel) lines.push('Level Range: ' + d.minLevel + ' - ' + d.maxLevel + ' m');
  if (d.lastToggledBy) lines.push('Last Toggled By: ' + d.lastToggledBy);
  if (d.pressureStatus) lines.push('Pressure Status: ' + d.pressureStatus);
  if (d.efficiency) lines.push('Efficiency: ' + d.efficiency + '%');
  return lines.join('\n');
}

function aiCall(system, question, devices) {
  if (AI_API_KEY) {
    return aiFetch({ model: AI_MODEL, max_tokens: 1000, system: system, messages: [{ role: 'user', content: question }] });
  }
  var q = (question||'').toLowerCase();
  var devs = devices || [];
  var pres  = devs.map(function(d){return parseFloat(d.pressure);}).filter(function(v){return !isNaN(v)&&v>0;});
  var flows = devs.map(function(d){return parseFloat(d.flow);}).filter(function(v){return !isNaN(v)&&v>0;});
  var pwrs  = devs.map(function(d){return parseFloat(d.power);}).filter(function(v){return !isNaN(v)&&v>0;});
  var volts = devs.map(function(d){return parseFloat(d.voltage);}).filter(function(v){return !isNaN(v)&&v>0;});
  var amps  = devs.map(function(d){return parseFloat(d.current);}).filter(function(v){return !isNaN(v)&&v>0;});
  var enrg  = devs.map(function(d){return parseFloat(d.energy);}).filter(function(v){return !isNaN(v)&&v>0;});
  var lvls  = devs.map(function(d){return parseFloat(d.level);}).filter(function(v){return !isNaN(v)&&v>0;});
  var online  = devs.filter(function(d){ return (d.status||'').toLowerCase()==='online'; }).length;
  var faultN  = devs.filter(function(d){ return (d.status||'').toLowerCase()==='fault'||d.button; }).length;
  var offln   = devs.filter(function(d){ return (d.status||'').toLowerCase()==='offline'; }).length;
  var pumps   = devs.filter(function(d){ var n=(d.device||'').toLowerCase(); return n.includes('pumping station')||n.includes('pump')||n.includes('booster')||(/^ps[\s-]?\d/).test(n); });
  var resvrs  = devs.filter(function(d){return (d.type||'').toLowerCase()==='reservoir'||((d.device||'').toLowerCase().includes('reservoir')&&(d.type||'').toLowerCase()!=='pressure');});
  var running = devs.filter(function(d){ return d.relay==1||d.relay==='1'||d.relay===true; });
  var stopped = devs.filter(function(d){ return d.relay==0||d.relay==='0'||d.relay===false; });
  var response;

  // Specific device query ("tell me about PS1", "show me Reservoir-A details")
  if ((q.includes('tell')||q.includes('show')||q.includes('about')||q.includes('details')||q.includes('status of')||q.includes('what is')) && devs.length) {
    var specific = _answerSpecificDevice(q, devs);
    if (specific) { response = specific; return Promise.resolve({ content: [{ text: response }] }); }
  }

  // Highest / max
  if (q.includes('highest')||q.includes('maximum')||q.includes('max')) {
    if (q.includes('pressure')||q.includes('psi')) {
      var v = _safeMax(pres); var d = _findDev(devs, 'pressure', v);
      response = 'Highest pressure: ' + (v!=null?v.toFixed(1):'N/A') + ' psi at ' + (d?d.device:'unknown') + '.';
    } else if (q.includes('flow')) {
      var v = _safeMax(flows); var d = _findDev(devs, 'flow', v);
      response = 'Highest flow: ' + (v!=null?v.toFixed(1):'N/A') + ' L/s at ' + (d?d.device:'unknown') + '.';
    } else if (q.includes('power')||q.includes('energy')||q.includes('watt')) {
      var v = _safeMax(pwrs); var d = _findDev(devs, 'power', v);
      response = 'Highest power: ' + (v!=null?v.toFixed(0):'N/A') + ' W at ' + (d?d.device:'unknown') + '.';
    } else if (q.includes('level')||q.includes('water')) {
      var v = _safeMax(lvls); var d = _findDev(devs, 'level', v);
      response = 'Highest water level: ' + (v!=null?v.toFixed(1):'N/A') + ' m at ' + (d?d.device:'unknown') + '.';
    } else if (q.includes('voltage')||q.includes('volt')) {
      var v = _safeMax(volts); var d = _findDev(devs, 'voltage', v);
      response = 'Highest voltage: ' + (v!=null?v.toFixed(0):'N/A') + ' V at ' + (d?d.device:'unknown') + '.';
    } else if (q.includes('current')||q.includes('amp')) {
      var v = _safeMax(amps); var d = _findDev(devs, 'current', v);
      response = 'Highest current: ' + (v!=null?v.toFixed(1):'N/A') + ' A at ' + (d?d.device:'unknown') + '.';
    } else {
      response = 'Specify what you want the highest of: pressure, flow, power, voltage, current, or water level.';
    }
  // Lowest / min
  } else if (q.includes('lowest')||q.includes('minimum')||q.includes('min')) {
    if (q.includes('pressure')||q.includes('psi')) {
      var v = _safeMin(pres); var d = _findDev(devs, 'pressure', v);
      response = 'Lowest pressure: ' + (v!=null?v.toFixed(1):'N/A') + ' psi at ' + (d?d.device:'unknown') + '.';
    } else if (q.includes('flow')) {
      var v = _safeMin(flows); var d = _findDev(devs, 'flow', v);
      response = 'Lowest flow: ' + (v!=null?v.toFixed(1):'N/A') + ' L/s at ' + (d?d.device:'unknown') + '.';
    } else if (q.includes('level')||q.includes('water')) {
      var v = _safeMin(lvls); var d = _findDev(devs, 'level', v);
      response = 'Lowest water level: ' + (v!=null?v.toFixed(1):'N/A') + ' m at ' + (d?d.device:'unknown') + '.';
    } else if (q.includes('voltage')||q.includes('volt')) {
      var v = _safeMin(volts); var d = _findDev(devs, 'voltage', v);
      response = 'Lowest voltage: ' + (v!=null?v.toFixed(0):'N/A') + ' V at ' + (d?d.device:'unknown') + '.';
    } else {
      response = 'Specify lowest of: pressure, flow, water level, or voltage.';
    }
  // Average
  } else if (q.includes('average')||q.includes('avg')||q.includes('mean')) {
    if (q.includes('pressure')||q.includes('psi')) response = 'Average pressure: ' + (_safeAvg(pres)!=null?_safeAvg(pres).toFixed(1):'N/A') + ' psi.';
    else if (q.includes('flow')) response = 'Average flow: ' + (_safeAvg(flows)!=null?_safeAvg(flows).toFixed(2):'N/A') + ' L/s.';
    else if (q.includes('power')||q.includes('watt')) response = 'Average power: ' + (_safeAvg(pwrs)!=null?_safeAvg(pwrs).toFixed(0):'N/A') + ' W.';
    else if (q.includes('voltage')||q.includes('volt')) response = 'Average voltage: ' + (_safeAvg(volts)!=null?_safeAvg(volts).toFixed(0):'N/A') + ' V.';
    else if (q.includes('current')||q.includes('amp')) response = 'Average current: ' + (_safeAvg(amps)!=null?_safeAvg(amps).toFixed(1):'N/A') + ' A.';
    else if (q.includes('level')||q.includes('water')) response = 'Average water level: ' + (_safeAvg(lvls)!=null?_safeAvg(lvls).toFixed(1):'N/A') + ' m.';
    else response = 'Average pressure: ' + (_safeAvg(pres)!=null?_safeAvg(pres).toFixed(1):'N/A') + ' psi, flow: ' + (_safeAvg(flows)!=null?_safeAvg(flows).toFixed(2):'N/A') + ' L/s, voltage: ' + (_safeAvg(volts)!=null?_safeAvg(volts).toFixed(0):'N/A') + ' V.';
  // Relay / running / stopped
  } else if (q.includes('running')||(q.includes('relay')&&(q.includes('on')||q.includes('active')))) {
    if (running.length) response = running.length + ' pump(s) running:\n' + running.map(function(d){
      var r = d.device + ' — Relay ON';
      if (d.pressure) r += ', ' + d.pressure + ' psi';
      if (d.flow) r += ', ' + d.flow + ' L/s';
      return r;
    }).join('\n');
    else response = 'No pumps currently running.';
  } else if (q.includes('stopped')||q.includes('off')||(q.includes('relay')&&q.includes('off'))) {
    if (stopped.length) response = stopped.length + ' pump(s) stopped:\n' + stopped.map(function(d){
      var r = d.device + ' — Relay OFF';
      if (d.pressure) r += ', ' + d.pressure + ' psi';
      if (d.level) r += ', level: ' + d.level + ' m';
      return r;
    }).join('\n');
    else response = 'All pumps are running.';
  } else if (q.includes('relay')) {
    var on = running.length, off = devs.filter(function(d){return d.relay!=null&&d.relay!=1&&d.relay!='1'&&d.relay!==true;}).length;
    var withRelay = devs.filter(function(d){return d.relay!=null;});
    response = 'Relay status — ' + on + ' ON, ' + off + ' OFF:\n' + withRelay.map(function(d){
      return d.device + ': ' + (d.relay==1||d.relay==='1'||d.relay===true?'● ON':'○ OFF');
    }).join('\n');
  // Voltage
  } else if (q.includes('voltage')||q.includes('volt')) {
    if (q.includes('low')) { var v = _safeMin(volts); var d = _findDev(devs,'voltage',v); response = 'Lowest voltage: ' + (v!=null?v.toFixed(0):'N/A') + ' V at ' + (d?d.device:'unknown') + '.'; }
    else { response = 'Voltage range: ' + (_safeMin(volts)!=null?_safeMin(volts).toFixed(0):'N/A') + ' – ' + (_safeMax(volts)!=null?_safeMax(volts).toFixed(0):'N/A') + ' V, avg ' + (_safeAvg(volts)!=null?_safeAvg(volts).toFixed(0):'N/A') + ' V.'; }
  // Current
  } else if (q.includes('current')||q.includes('amp')) {
    response = 'Current range: ' + (_safeMin(amps)!=null?_safeMin(amps).toFixed(1):'N/A') + ' – ' + (_safeMax(amps)!=null?_safeMax(amps).toFixed(1):'N/A') + ' A.';
  // Energy
  } else if (q.includes('energy')||q.includes('kwh')) {
    response = 'Energy range: ' + (_safeMin(enrg)!=null?_safeMin(enrg).toFixed(1):'N/A') + ' – ' + (_safeMax(enrg)!=null?_safeMax(enrg).toFixed(1):'N/A') + ' kWh. Total: ' + (enrg.length?enrg.reduce(function(a,b){return a+b;},0).toFixed(1):'N/A') + ' kWh.';
  // Power
  } else if (q.includes('power')||q.includes('watt')) {
    response = 'Power range: ' + (_safeMin(pwrs)!=null?_safeMin(pwrs).toFixed(0):'N/A') + ' – ' + (_safeMax(pwrs)!=null?_safeMax(pwrs).toFixed(0):'N/A') + ' W. Total: ' + (pwrs.length?pwrs.reduce(function(a,b){return a+b;},0).toFixed(0):'N/A') + ' W.';
  // Pressure (general)
  } else if (q.includes('pressure')||q.includes('psi')) {
    response = 'Pressure range: ' + (_safeMin(pres)!=null?_safeMin(pres).toFixed(1):'N/A') + ' – ' + (_safeMax(pres)!=null?_safeMax(pres).toFixed(1):'N/A') + ' psi, avg ' + (_safeAvg(pres)!=null?_safeAvg(pres).toFixed(1):'N/A') + ' psi.';
  // Flow (general)
  } else if (q.includes('flow')) {
    response = 'Flow range: ' + (_safeMin(flows)!=null?_safeMin(flows).toFixed(1):'N/A') + ' – ' + (_safeMax(flows)!=null?_safeMax(flows).toFixed(1):'N/A') + ' L/s. Total: ' + (flows.length?flows.reduce(function(a,b){return a+b;},0).toFixed(1):'N/A') + ' L/s.';
  // Level / water
  } else if (q.includes('level')||q.includes('water')) {
    response = 'Water level range: ' + (_safeMin(lvls)!=null?_safeMin(lvls).toFixed(1):'N/A') + ' – ' + (_safeMax(lvls)!=null?_safeMax(lvls).toFixed(1):'N/A') + ' m.';
  // Pumps
  } else if (q.includes('pump')) {
    var list = pumps.map(function(d){
      var s = d.device + ' (' + (d.status||'?') + ')';
      var relayState = d.relay==1||d.relay==='1'||d.relay===true ? '● RUNNING' : '○ OFF';
      s += ' — ' + relayState;
      if (d.pressure) s += ', ' + d.pressure + ' psi';
      if (d.flow) s += ', ' + d.flow + ' L/s';
      if (d.power) s += ', ' + d.power + ' W';
      if (d.button) s += ' ⚠ FAULT';
      return s;
    }).join('\n');
    response = pumps.length + ' pump(s):\n' + list;
  // Reservoirs
  } else if (q.includes('reservoir')) {
    var list = resvrs.map(function(d){
      var s = d.device + ' (' + (d.status||'?') + ') — Level: ' + (d.level||'N/A') + ' m';
      if (d.relay!=null) s += ', Relay: ' + (d.relay==1||d.relay==='1'?'ON':'OFF');
      if (d.minLevel) s += ', Range: ' + d.minLevel + '-' + d.maxLevel + ' m';
      return s;
    }).join('\n');
    response = resvrs.length + ' reservoir(s):\n' + list;
  // Count / how many / total
  } else if (q.includes('how many')||q.includes('count')) {
    if (q.includes('online')) response = online + ' device(s) online out of ' + devs.length + ' total.';
    else if (q.includes('offline')) response = offln + ' device(s) offline.';
    else if (q.includes('fault')||q.includes('alarm')) response = faultN + ' device(s) in fault.';
    else if (q.includes('device')) response = devs.length + ' device(s) total.';
    else if (q.includes('pump')) response = pumps.length + ' pump(s), ' + running.length + ' running, ' + stopped.filter(function(d){return d.relay!=null;}).length + ' stopped.';
    else if (q.includes('reservoir')) response = resvrs.length + ' reservoir(s).';
    else if (q.includes('running')||q.includes('active')) response = running.length + ' pump(s) running.';
    else response = devs.length + ' total (' + online + ' online, ' + faultN + ' fault, ' + offln + ' offline). '
      + pumps.length + ' pumps (' + running.length + ' running).';
  // List all
  } else if (q.includes('list')||q.includes('show all')||q.includes('all device')||q.includes('everything')) {
    response = devs.map(function(d){
      return d.device + ' (' + (d.type||'?') + ') ' + (d.status||'?') + (d.pressure?' P:'+d.pressure:'') + (d.flow?' F:'+d.flow:'') + (d.level?' L:'+d.level:'') + (d.relay!=null?' Relay:'+(d.relay==1||d.relay==='1'?'ON':'OFF'):'') + (d.button?' FAULT':'');
    }).join('\n');
  // Alarm / fault
  } else if (q.includes('alarm')||q.includes('fault')||q.includes('error')||q.includes('issue')) {
    var faultDevs = devs.filter(function(d){ return (d.status||'').toLowerCase()==='fault'||d.button; });
    if (faultDevs.length) {
      var detail = faultDevs.map(function(d){ return d.device + (d.pressure?' (psi:'+d.pressure+')':'') + (d.flow?' (flow:'+d.flow+')':'') + (d.button?' [FAULT]':''); }).join('\n');
      response = faultDevs.length + ' device(s) in fault:\n' + detail;
    } else response = 'No active faults. All devices operating normally.';
  // Efficiency
  } else if (q.includes('efficiency')||q.includes('performance')) {
    var avgEff = pwrs.length && flows.length ? (flows.reduce(function(a,b){return a+b;},0) / (pwrs.reduce(function(a,b){return a+b;},0)||1) * 100).toFixed(2) : 'N/A';
    response = 'Overall efficiency: ' + avgEff + ' L/s per kW';
    var stored = devs.filter(function(d){return parseFloat(d.efficiency)>0;});
    if (stored.length) response += '. Stored device efficiencies: ' + stored.map(function(d){return d.device + '=' + d.efficiency + '%';}).join(', ');
    response += '.';
  // GPS / location
  } else if (q.includes('gps')||q.includes('location')||q.includes('where')||q.includes('coordinate')||q.includes('lat')) {
    var withGps = devs.filter(function(d){return d.latitude;});
    if (withGps.length) response = withGps.map(function(d){ return d.device + ': ' + d.latitude + ', ' + d.longitude; }).join('\n');
    else response = 'No GPS coordinates available for any device.';
  // Firmware
  } else if (q.includes('firmware')||q.includes('version')||q.includes('fw')) {
    var withFw = devs.filter(function(d){return d.firmware;});
    if (withFw.length) response = withFw.map(function(d){ return d.device + ': ' + d.firmware; }).join('\n');
    else response = 'No firmware info available.';
  // Online / status
  } else if (q.includes('online')||q.includes('status')) {
    response = 'Online: ' + online + ', Fault: ' + faultN + ', Offline: ' + offln + ' (out of ' + devs.length + ' total).';
  // Type breakdown
  } else if (q.includes('type')||q.includes('category')||q.includes('breakdown')) {
    var byType = {};
    devs.forEach(function(d){ var t = d.type||'Unknown'; byType[t] = (byType[t]||0) + 1; });
    response = Object.keys(byType).map(function(t){ return t + ': ' + byType[t]; }).join(', ');
  // Help
  } else if (q.includes('help')||q.includes('what can you')||q.includes('commands')) {
    response = 'I know all your SCADA data. Ask about: pressure, flow, power, voltage, current, energy, water level, relay status, pumps, reservoirs, faults, alarms, GPS location, firmware, efficiency, thresholds, or any specific device by name.';
  // Last-resort: show overview
  } else {
    response = 'System: ' + devs.length + ' devices (' + online + ' online, ' + faultN + ' fault, ' + offln + ' offline). '
      + pumps.length + ' pumps (' + running.length + ' running, ' + (pumps.length - running.length) + ' stopped), ' + resvrs.length + ' reservoirs. '
      + (pres.length?'Pressure ' + _safeMin(pres).toFixed(0) + '-' + _safeMax(pres).toFixed(0) + ' psi. ':'')
      + (flows.length?'Flow ' + _safeMin(flows).toFixed(0) + '-' + _safeMax(flows).toFixed(0) + ' L/s. ':'')
      + 'Ask about any device or metric.';
  }
  return Promise.resolve({ content: [{ text: response }] });
}
function aiLocalFallback(body, context) {
  return Promise.resolve({ content: [{ text: 'AI service unavailable. ' + (context ? context.slice(0,150) : 'Check AI config.') }] });
}
function toggleAIChat() {
  var panel = document.getElementById('ai-chat-panel');
  var fab = document.getElementById('ai-chat-fab');
  if (!panel) return;
  var show = window.getComputedStyle(panel).display === 'none';
  panel.style.display = show ? 'flex' : 'none';
  if (fab) fab.style.display = show ? 'none' : 'block';
}

function aiCacheKey(body) {
  var s = JSON.stringify(body);
  var h = 0, i, chr;
  for (i = 0; i < s.length; i++) { chr = s.charCodeAt(i); h = ((h << 5) - h) + chr; h |= 0; }
  return 'ac_' + h;
}

function aiFetch(bodyOverrides, retries) {
  retries = retries || 2;
  var body = bodyOverrides || {};
  if (!body.model) body.model = AI_MODEL;
  if (body.system) {
    body.messages = [{ role: 'system', content: body.system }].concat(body.messages || []);
    delete body.system;
  }
  var ck = aiCacheKey(body);
  if (AI_CACHE[ck] && Date.now() - AI_CACHE[ck].ts < 120000) {
    return Promise.resolve(JSON.parse(JSON.stringify(AI_CACHE[ck].data)));
  }
  var headers = { 'Content-Type': 'application/json' };
  if (AI_API_KEY) headers['Authorization'] = 'Bearer ' + AI_API_KEY;
  return fetch(AI_ENDPOINT, { method: 'POST', headers: headers, body: JSON.stringify(body) })
    .then(function(r) {
      if (!r.ok) throw new Error('API ' + r.status);
      return r.json();
    }).then(function(data) {
      AI_CACHE[ck] = { data: data, ts: Date.now() };
      return { content: [{ text: (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '' }] };
    }).catch(function(err) {
      if (retries > 0) return aiFetch(bodyOverrides, retries - 1);
      return aiLocalFallback(JSON.stringify(body), body.messages ? body.messages.map(function(m){return m.content;}).join(' ') : '');
    });
}

function aiFetchStream(bodyOverrides, onToken, onDone, onError) {
  var body = bodyOverrides || {};
  if (!body.model) body.model = AI_MODEL;
  if (body.system) {
    body.messages = [{ role: 'system', content: body.system }].concat(body.messages || []);
    delete body.system;
  }
  body.stream = true;
  var headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
  if (AI_API_KEY) headers['Authorization'] = 'Bearer ' + AI_API_KEY;

  // Abort controller for stream cancellation
  var ac = new AbortController();
  window._aiAbort = ac;

  var timeout = setTimeout(function() { ac.abort(); }, 60000);

  return fetch(AI_ENDPOINT, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ac.signal })
    .then(function(response) {
      clearTimeout(timeout);
      if (!response.ok) throw new Error('Stream HTTP ' + response.status);
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var fullText = '';
      var buffer = '';

      function readChunk() {
        reader.read().then(function(result) {
          if (result.done) {
            if (onDone) onDone(fullText);
            return;
          }
          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop();
          lines.forEach(function(line) {
            if (line.startsWith('data: ')) {
              var data = line.slice(6).trim();
              if (data === '[DONE]') {
                if (onDone) onDone(fullText);
                return;
              }
              try {
                var parsed = JSON.parse(data);
                var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content;
                if (delta) {
                  fullText += delta;
                  if (onToken) onToken(delta);
                }
              } catch(e) { /* skip malformed chunk */ }
            }
          });
          readChunk();
        }).catch(function(err) {
          if (err.name === 'AbortError') {
            if (onDone) onDone(fullText);
          } else {
            if (onError) onError(err);
          }
        });
      }
      readChunk();
    }).catch(function(err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        if (onDone) onDone(fullText || '');
      } else {
        if (onError) onError(err);
      }
    });
}

function clearAICache() {
  AI_CACHE = {};
  localStorage.removeItem('agus_ai_cache');
}

function sendAIMessage() {
  var input = document.getElementById('ai-chat-input');
  var question = (input ? input.value.trim() : '');
  if (!question) return;
  if (input) input.value = '';
  addAIChatMessage(question, 'user');
  aiChatHistory.push({ role: 'user', content: question });
  var typingEl = addAIChatMessage('', 'bot');
  if (typingEl) typingEl.classList.add('ai-msg-typing');
  document.getElementById('ai-chat-status').innerText = 'AI is thinking…';
  apiGet('getDashboardData').then(function(devices) {
    var sysPrompt = buildAISystemContext(devices);
    if (!devices || !devices.length) {
      if (typingEl) { typingEl.innerText = '⚠ Unable to load device data. Check network / API connection.'; typingEl.classList.remove('ai-msg-typing'); }
      document.getElementById('ai-chat-status').innerText = 'Data error';
      return;
    }
    if (AI_API_KEY) {
      var fullReply = '';
      aiFetchStream(
        { model: AI_MODEL, max_tokens: 1000, system: sysPrompt, messages: aiChatHistory },
        function(token) {
          fullReply += token;
          if (typingEl) { typingEl.innerText = fullReply; typingEl.classList.remove('ai-msg-typing'); }
          document.getElementById('ai-chat-status').innerText = 'Streaming…';
        },
        function(fullText) {
          if (!fullText) fullText = 'Sorry, I could not generate a response.';
          aiChatHistory.push({ role: 'assistant', content: fullText });
          if (typingEl) { typingEl.innerText = fullText; typingEl.classList.remove('ai-msg-typing'); }
          document.getElementById('ai-chat-status').innerText = 'Ready';
        },
        function(err) {
          aiFetch({ model: AI_MODEL, max_tokens: 1000, system: sysPrompt, messages: aiChatHistory }).then(function(data) {
            var reply = (data.content && data.content[0] && data.content[0].text) ? data.content[0].text : 'Sorry, I could not generate a response.';
            aiChatHistory.push({ role: 'assistant', content: reply });
            if (typingEl) { typingEl.innerText = reply; typingEl.classList.remove('ai-msg-typing'); }
            document.getElementById('ai-chat-status').innerText = 'Ready';
          }).catch(function(e) {
            if (typingEl) { typingEl.innerText = '⚠ Error: ' + (e.message || e); typingEl.classList.remove('ai-msg-typing'); }
            document.getElementById('ai-chat-status').innerText = 'Error — try again';
          });
        }
      );
    } else {
      aiCall(sysPrompt, question, devices).then(function(data) {
        var reply = (data.content && data.content[0] && data.content[0].text) ? data.content[0].text : 'Sorry, I could not generate a response.';
        aiChatHistory.push({ role: 'assistant', content: reply });
        if (typingEl) { typingEl.innerText = reply; typingEl.classList.remove('ai-msg-typing'); }
        document.getElementById('ai-chat-status').innerText = 'Ready';
      }).catch(function(err) {
        if (typingEl) { typingEl.innerText = '⚠ Error: ' + (err.message || err); typingEl.classList.remove('ai-msg-typing'); }
        document.getElementById('ai-chat-status').innerText = 'Error — try again';
      });
    }
  }).catch(function(err) {
    if (typingEl) { typingEl.innerText = '⚠ Network error: ' + (err.message || err); typingEl.classList.remove('ai-msg-typing'); }
    document.getElementById('ai-chat-status').innerText = 'Connection error';
  });
}

// ============================================================
// Module 5: AI-Powered Alarm Correlation (batch announcements)
// ============================================================
var pendingAlarms = [];
var batchTimer = null;
var lastCorrelatedDigest = '';
function correlateAndAnnounce(deviceName, alarmType, reading) {
  pendingAlarms.push({ device: deviceName, type: alarmType, reading: reading, time: Date.now() });
  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = setTimeout(flushAndCorrelate, 1500);
}
function flushAndCorrelate() {
  var snapshot = pendingAlarms.slice();
  pendingAlarms = [];
  if (snapshot.length === 1) {
    var a = snapshot[0];
    var isRes = a.device.toLowerCase().includes('reservoir');
    if (isRes) originalSpeakAlarm(a.device, a.type, true);
    else originalSpeakPSAlarm(a.device, a.type);
    return;
  }
  var bulletList = snapshot.map(function(a) { return '• ' + a.device + ': ' + a.type + (a.reading ? ' (' + a.reading + ')' : ''); }).join('\n');
  aiFetch({ model: AI_MODEL, max_tokens: 200, messages: [{ role: 'user', content: 'You are an alarm correlator for a water utility SCADA system.\nThese alarms fired simultaneously:\n' + bulletList + '\n\nIn ONE short sentence (max 20 words), identify the most likely single root cause. Be direct.' }] }).then(function(data) {
    var cause = (data.content && data.content[0]) ? data.content[0].text.trim() : 'Multiple simultaneous alarms — check system.';
    var digest = 'AI correlated ' + snapshot.length + ' alarms. ' + cause;
    if (digest !== lastCorrelatedDigest) {
      lastCorrelatedDigest = digest;
      var u = new SpeechSynthesisUtterance(digest); u.lang = 'en-US'; u.rate = 0.85; u.volume = 1;
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    }
    showNotification('⚡ AI Alarm Digest: ' + cause, 'error');
  }).catch(function() { snapshot.forEach(function(a) { originalSpeakPSAlarm(a.device, a.type); }); });
}

// ============================================================
// Module 6: Energy Optimization Advisor
// ============================================================
function aggregateEnergyStats(deviceName, rows) {
  if (!rows || !rows.length) return null;
  var keys = Object.keys(rows[0]);
  var flowK = keys.find(function(k){return /flowrate|flow/i.test(k);});
  var powerK = keys.find(function(k){return /power/i.test(k);});
  var energyK = keys.find(function(k){return /energy|kwh|kw.h/i.test(k);});
  var timeK = keys.find(function(k){return /time|date|timestamp/i.test(k);}) || keys[0];
  var totalEnergy = 0, peakPower = 0, lowFlowEvents = 0, highPowerEvents = 0;
  var hourBuckets = new Array(24).fill(0).map(function() { return { energy: 0, count: 0 }; });
  rows.forEach(function(r) {
    var pw = parseFloat(r[powerK]); var en = parseFloat(r[energyK]); var fl = parseFloat(r[flowK]);
    var ts = parseSheetDate(r[timeK]);
    if (!isNaN(en)) totalEnergy += en;
    if (!isNaN(pw) && pw > peakPower) peakPower = pw;
    if (!isNaN(fl) && fl < 2 && fl > 0) lowFlowEvents++;
    if (!isNaN(pw) && pw > 3000) highPowerEvents++;
    if (ts && !isNaN(pw)) { var h = ts.getHours(); hourBuckets[h].energy += pw; hourBuckets[h].count++; }
  });
  var hourlyAvg = hourBuckets.map(function(b, h) { return { h: h, avg: b.count ? b.energy / b.count : 0 }; });
  hourlyAvg.sort(function(a,b) { return b.avg - a.avg; });
  var peakHours = hourlyAvg.slice(0,3).map(function(x){return x.h + ':00';}).join(', ');
  var offPeakHours = hourlyAvg.slice(-3).map(function(x){return x.h + ':00';}).join(', ');
  return { device: deviceName, totalEnergyKwh: totalEnergy.toFixed(1), peakPowerW: peakPower.toFixed(0), lowFlowEvents: lowFlowEvents, highPowerEvents: highPowerEvents, peakHours: peakHours, offPeakHours: offPeakHours, sampleCount: rows.length };
}
function openEnergyAdvisor() {
  var old = document.getElementById('energy-advisor-overlay'); if (old) old.remove();
  apiCached('getDashboardData').then(function(devices) {
    if (!devices || !devices.length) { showNotification('Unable to load device data.', 'error'); return; }
    var pumpDevices = devices.filter(function(d) {
      var n = (d.device||'').toLowerCase(), t = (d.type||'').toLowerCase();
      return n.includes('pump') || n.includes('booster') || t.includes('pump') ||
             (d.relay !== undefined && d.flow !== undefined && d.power !== undefined);
    });
    if (!pumpDevices.length) { showNotification('No pumping station devices found.', 'info'); return; }
    var overlay = document.createElement('div');
    overlay.id = 'energy-advisor-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,10,30,0.75);z-index:5200;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = '<div style="background:#fff;border-radius:16px;width:560px;max-width:95vw;max-height:88vh;overflow-y:auto;padding:28px 30px;box-shadow:0 24px 60px rgba(0,0,0,0.4);"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;"><div><h3 style="margin:0;color:#002b5c;">&#9889; AI Energy Advisor</h3><div style="font-size:12px;color:#7a8fa6;">Analysing pump data &mdash; recommendations below</div></div><button onclick="document.getElementById(\'energy-advisor-overlay\').remove()" style="background:#f0f4f9;border:none;width:30px;height:30px;border-radius:50%;font-size:16px;cursor:pointer;">&#10005;</button></div><div id="energy-advisor-body"><div style="text-align:center;padding:40px;color:#7a8fa6;"><div class="spinner" style="margin:0 auto 12px;"></div>Loading pump data…</div></div></div>';
    document.body.appendChild(overlay);
    var fetches = pumpDevices.map(function(d) { return apiGet('getSheetData', { sheet: d.device }).then(function(rows) { return aggregateEnergyStats(d.device, rows); }).catch(function() { return null; }); });
    Promise.all(fetches).then(function(statsArray) {
      statsArray = statsArray.filter(Boolean);
      if (!statsArray.length) { document.getElementById('energy-advisor-body').innerHTML = '<p style="color:#7a8fa6;">No data available yet for any pumping station.</p>'; return; }
      var statsText = statsArray.map(function(s) { return '# ' + s.device + '\n- Total energy: ' + s.totalEnergyKwh + ' kWh\n- Peak power: ' + s.peakPowerW + ' W\n- Low-flow events: ' + s.lowFlowEvents + '\n- High-power events: ' + s.highPowerEvents + '\n- Peak hours: ' + s.peakHours + '\n- Off-peak: ' + s.offPeakHours; }).join('\n\n');
      aiCall('You are an energy efficiency advisor for a water utility (AGUS).', 'Analyse this pump energy data and give 3-5 concrete, numbered recommendations.\nFocus on optimal run-time scheduling, load balancing, efficiency improvements.\nUse plain English. Each recommendation 1-2 sentences.\n\n' + statsText).then(function(data) {
        var advice = (data.content && data.content[0]) ? data.content[0].text.trim() : 'Unable to generate recommendations.';
        var statsHtml = statsArray.map(function(s) { return '<div style="background:#f8faff;border:1px solid #d0e4f7;border-radius:8px;padding:10px 14px;margin-bottom:10px;"><div style="font-weight:700;color:#002b5c;">&#9881;&#65039; ' + s.device + '</div><div style="font-size:12px;color:#475569;display:grid;grid-template-columns:1fr 1fr;gap:3px;"><span>Energy: <b>' + s.totalEnergyKwh + ' kWh</b></span><span>Peak power: <b>' + s.peakPowerW + ' W</b></span><span>Low-flow events: <b>' + s.lowFlowEvents + '</b></span><span>Peak hours: <b>' + s.peakHours + '</b></span></div></div>'; }).join('');
        var adviceHtml = advice.split('\n').map(function(line){ return line.trim() ? '<p style="margin:6px 0;color:#1e293b;font-size:13px;">' + line + '</p>' : ''; }).join('');
        document.getElementById('energy-advisor-body').innerHTML = statsHtml + '<div style="margin-top:18px;padding:16px;background:linear-gradient(135deg,#f0f8ff,#e8f4fd);border-radius:10px;"><div style="font-size:12px;font-weight:800;color:#0044aa;margin-bottom:10px;">&#129302; AI Recommendations</div>' + adviceHtml + '</div>';
      }).catch(function(err) { document.getElementById('energy-advisor-body').innerHTML = '<p style="color:#e53935;">Error: ' + (err.message || err) + '</p>'; });
    });
  }).catch(function(err) {
    showNotification('⚠ Failed to load device data: ' + (err.message || err), 'error');
  });
}

// ============================================================
// Cost per Cubic Calculator
// ============================================================
function openCostCalculator() {
  var old = document.getElementById('cost-calc-overlay'); if (old) old.remove();
  var overlay = document.createElement('div');
  overlay.id = 'cost-calc-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,10,30,0.75);z-index:5300;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = '<div style="background:#fff;border-radius:16px;width:680px;max-width:95vw;max-height:90vh;overflow-y:auto;padding:28px 30px;box-shadow:0 24px 60px rgba(0,0,0,0.4);">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">'
    + '<div><h3 style="margin:0;color:#002b5c;">&#9889; Cost per Cubic Calculator</h3>'
    + '<div style="font-size:12px;color:#7a8fa6;">Energy cost per m³ for pumping stations &amp; booster pumps</div></div>'
    + '<button onclick="document.getElementById(\'cost-calc-overlay\').remove()" style="background:#f0f4f9;border:none;width:30px;height:30px;border-radius:50%;font-size:16px;cursor:pointer;">&#10005;</button>'
    + '</div>'
    + '<div id="cost-calc-body"><div style="text-align:center;padding:40px;color:#7a8fa6;"><div class="spinner" style="margin:0 auto 12px;"></div>Loading pump data&#8230;</div></div></div>';
  document.body.appendChild(overlay);

  apiCached('getDashboardData').then(function(devices) {
    if (!devices || !devices.length) { document.getElementById('cost-calc-body').innerHTML = '<p style="color:#7a8fa6;padding:20px;">No device data available.</p>'; return; }
    var pumpDevices = devices.filter(function(d) {
      var n = (d.device||'').toLowerCase();
      return n.includes('pumping station') || n.includes('reservoir booster') || n.includes('booster');
    });
    if (!pumpDevices.length) { document.getElementById('cost-calc-body').innerHTML = '<p style="color:#7a8fa6;padding:20px;">No pumping stations or booster pumps found.</p>'; return; }
    var fetches = pumpDevices.map(function(d) {
      return apiGet('getSheetData', { sheet: d.device }).then(function(rows) { return aggregateEnergyStats(d.device, rows); }).catch(function() { return null; });
    });
    Promise.all(fetches).then(function(statsArray) {
      statsArray = statsArray.filter(Boolean);
      if (!statsArray.length) { document.getElementById('cost-calc-body').innerHTML = '<p style="color:#7a8fa6;padding:20px;">No historical energy data available yet.</p>'; return; }
      renderCostCalcTable(statsArray);
    });
  }).catch(function(err) {
    var body = document.getElementById('cost-calc-body');
    if (body) body.innerHTML = '<p style="color:#e53935;padding:20px;">&#9888; Error loading data: ' + (err.message || err) + '</p>';
  });
}

function renderCostCalcTable(statsArray) {
  var body = document.getElementById('cost-calc-body');
  var savedRate = localStorage.getItem('agus_cost_per_kwh') || '12';
  var savedDaily = localStorage.getItem('agus_prod_daily') || '';
  var savedWeekly = localStorage.getItem('agus_prod_weekly') || '';
  var savedMonthly = localStorage.getItem('agus_prod_monthly') || '';

  var rowsHtml = statsArray.map(function(s) {
    return '<tr>'
      + '<td style="padding:8px 10px;font-weight:700;color:#002b5c;border-bottom:1px solid #e5eef9;">' + s.device + '</td>'
      + '<td style="padding:8px 10px;text-align:right;border-bottom:1px solid #e5eef9;">' + s.totalEnergyKwh + '</td>'
      + '<td style="padding:8px 10px;text-align:right;border-bottom:1px solid #e5eef9;font-weight:700;color:#15803d;" class="cost-cell" data-idx="' + statsArray.indexOf(s) + '">—</td>'
      + '<td style="padding:8px 10px;text-align:right;border-bottom:1px solid #e5eef9;" class="daily-cell" data-idx="' + statsArray.indexOf(s) + '">—</td>'
      + '<td style="padding:8px 10px;text-align:right;border-bottom:1px solid #e5eef9;" class="weekly-cell" data-idx="' + statsArray.indexOf(s) + '">—</td>'
      + '<td style="padding:8px 10px;text-align:right;border-bottom:1px solid #e5eef9;" class="monthly-cell" data-idx="' + statsArray.indexOf(s) + '">—</td>'
      + '</tr>';
  }).join('');

  body.innerHTML = '<div style="margin-bottom:16px;display:grid;grid-template-columns:1fr 1fr;gap:10px;">'
    + '<label style="font-size:12px;font-weight:700;color:#2c3e50;">Cost per kWh (PHP)'
    + '<input id="cost-per-kwh" type="number" step="0.001" min="0" value="' + savedRate + '" style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1.5px solid #d0e4f7;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;"></label>'
    + '<label style="font-size:12px;font-weight:700;color:#2c3e50;">Daily Production (m\u00B3)'
    + '<input id="prod-daily" type="number" step="1" min="0" value="' + savedDaily + '" placeholder="e.g. 5000" style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1.5px solid #d0e4f7;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;"></label>'
    + '<label style="font-size:12px;font-weight:700;color:#2c3e50;">Weekly Production (m\u00B3)'
    + '<input id="prod-weekly" type="number" step="1" min="0" value="' + savedWeekly + '" placeholder="e.g. 35000" style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1.5px solid #d0e4f7;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;"></label>'
    + '<label style="font-size:12px;font-weight:700;color:#2c3e50;">Monthly Production (m\u00B3)'
    + '<input id="prod-monthly" type="number" step="1" min="0" value="' + savedMonthly + '" placeholder="e.g. 150000" style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1.5px solid #d0e4f7;border-radius:8px;font-size:14px;outline:none;box-sizing:border-box;"></label>'
    + '</div>'
    + '<button onclick="recalcCostTable()" style="width:100%;padding:10px;background:linear-gradient(135deg,#004080,#0066cc);color:white;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;margin-bottom:16px;">Calculate</button>'
    + '<div style="overflow-x:auto;">'
    + '<table style="width:100%;border-collapse:collapse;font-size:13px;">'
    + '<thead><tr style="background:#f0f7ff;border-radius:8px;">'
    + '<th style="padding:10px;text-align:left;color:#2c3e50;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Device</th>'
    + '<th style="padding:10px;text-align:right;color:#2c3e50;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Energy (kWh)</th>'
    + '<th style="padding:10px;text-align:right;color:#2c3e50;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Cost (PHP)</th>'
    + '<th style="padding:10px;text-align:right;color:#2c3e50;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Daily \u20b1/m\u00B3</th>'
    + '<th style="padding:10px;text-align:right;color:#2c3e50;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Weekly \u20b1/m\u00B3</th>'
    + '<th style="padding:10px;text-align:right;color:#2c3e50;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Monthly \u20b1/m\u00B3</th>'
    + '</tr></thead>'
    + '<tbody>' + rowsHtml + '</tbody></table></div>'
    + '<div style="margin-top:12px;padding:10px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:12px;color:#166534;"><strong>Cost per m\u00B3</strong> = Energy (kWh) &times; Cost per kWh &divide; Production Volume. Enter your production volumes above, then click Calculate.</div>';

  window._costCalcStats = statsArray;
}

function getCostKpiCard() {
  var rate = localStorage.getItem('agus_cost_per_kwh') || '';
  var totalCost = localStorage.getItem('agus_cost_calc_total_cost') || '';
  var dailyCpm = localStorage.getItem('agus_cost_calc_daily_cpm') || '';
  var monthlyCpm = localStorage.getItem('agus_cost_calc_monthly_cpm') || '';
  if (!rate && !totalCost) return '';
  var cards = '';
  if (totalCost) {
    cards += '<div style="background:linear-gradient(135deg,#7c3aed18,#7c3aed08);border:1.5px solid #7c3aed40;border-radius:14px;padding:16px 18px;min-width:130px;">'
      + '<div style="font-size:22px;margin-bottom:6px;">&#8369;</div>'
      + '<div style="font-size:11px;font-weight:800;color:#5575a0;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:4px;">Energy Cost</div>'
      + '<div style="font-size:22px;font-weight:800;color:#7c3aed;">\u20b1' + totalCost + ' <span style="font-size:13px;font-weight:600;"></span></div>'
      + '<div style="font-size:11px;color:#7a8fa6;margin-top:2px;">@ \u20b1' + rate + '/kWh</div></div>';
  }
  if (dailyCpm) {
    cards += '<div style="background:linear-gradient(135deg,#0891b218,#0891b208);border:1.5px solid #0891b240;border-radius:14px;padding:16px 18px;min-width:130px;">'
      + '<div style="font-size:22px;margin-bottom:6px;">&#8721;</div>'
      + '<div style="font-size:11px;font-weight:800;color:#5575a0;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:4px;">Cost/m\u00B3 Daily</div>'
      + '<div style="font-size:22px;font-weight:800;color:#0891b2;">\u20b1' + dailyCpm + ' <span style="font-size:13px;font-weight:600;"></span></div>'
      + '<div style="font-size:11px;color:#7a8fa6;margin-top:2px;">Per cubic meter</div></div>';
  }
  if (monthlyCpm) {
    cards += '<div style="background:linear-gradient(135deg,#d9770618,#d9770608);border:1.5px solid #d9770640;border-radius:14px;padding:16px 18px;min-width:130px;">'
      + '<div style="font-size:22px;margin-bottom:6px;">&#8721;</div>'
      + '<div style="font-size:11px;font-weight:800;color:#5575a0;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:4px;">Cost/m\u00B3 Monthly</div>'
      + '<div style="font-size:22px;font-weight:800;color:#d97706;">\u20b1' + monthlyCpm + ' <span style="font-size:13px;font-weight:600;"></span></div>'
      + '<div style="font-size:11px;color:#7a8fa6;margin-top:2px;">Per cubic meter</div></div>';
  }
  return cards;
}

function recalcCostTable() {
  var rate = parseFloat(document.getElementById('cost-per-kwh').value) || 0;
  var daily = parseFloat(document.getElementById('prod-daily').value) || 0;
  var weekly = parseFloat(document.getElementById('prod-weekly').value) || 0;
  var monthly = parseFloat(document.getElementById('prod-monthly').value) || 0;

  var stats = window._costCalcStats || [];
  var totalEnergy = 0, totalCost = 0;

  stats.forEach(function(s) {
    var energy = parseFloat(s.totalEnergyKwh) || 0;
    var cost = energy * rate;
    totalEnergy += energy;
    totalCost += cost;

    var costCell = document.querySelector('.cost-cell[data-idx="' + stats.indexOf(s) + '"]');
    var dailyCell = document.querySelector('.daily-cell[data-idx="' + stats.indexOf(s) + '"]');
    var weeklyCell = document.querySelector('.weekly-cell[data-idx="' + stats.indexOf(s) + '"]');
    var monthlyCell = document.querySelector('.monthly-cell[data-idx="' + stats.indexOf(s) + '"]');

    if (costCell) costCell.textContent = cost.toFixed(2);
    if (dailyCell) dailyCell.textContent = (daily && cost) ? (cost / daily).toFixed(4) : '—';
    if (weeklyCell) weeklyCell.textContent = (weekly && cost) ? (cost / weekly).toFixed(4) : '—';
    if (monthlyCell) monthlyCell.textContent = (monthly && cost) ? (cost / monthly).toFixed(4) : '—';
  });

  localStorage.setItem('agus_cost_per_kwh', rate.toString());
  localStorage.setItem('agus_prod_daily', daily ? daily.toString() : '');
  localStorage.setItem('agus_prod_weekly', weekly ? weekly.toString() : '');
  localStorage.setItem('agus_prod_monthly', monthly ? monthly.toString() : '');
  localStorage.setItem('agus_cost_calc_total_energy', totalEnergy.toFixed(1));
  localStorage.setItem('agus_cost_calc_total_cost', totalCost.toFixed(2));
  localStorage.setItem('agus_cost_calc_daily_cpm', (daily && totalCost) ? (totalCost / daily).toFixed(4) : '');
  localStorage.setItem('agus_cost_calc_weekly_cpm', (weekly && totalCost) ? (totalCost / weekly).toFixed(4) : '');
  localStorage.setItem('agus_cost_calc_monthly_cpm', (monthly && totalCost) ? (totalCost / monthly).toFixed(4) : '');

  showNotification('Costs calculated: $' + totalCost.toFixed(2) + ' total @ $' + rate.toFixed(3) + '/kWh', 'success');
}

// ============================================================
// MONKEY PATCHES: override original functions with AI-enhanced versions
// ============================================================
(function patchOriginal() {
  originalSpeakAlarm = window.speakAlarm;
  originalSpeakPSAlarm = window.speakPSAlarm;
  window.speakAlarm = function(deviceName, alarmType, isReservoir) { correlateAndAnnounce(deviceName, alarmType, null); };
  window.speakPSAlarm = function(deviceName, alarmType) { correlateAndAnnounce(deviceName, alarmType, null); };

  var originalUpdateDeviceList = window.updateDeviceList;
  window.updateDeviceList = function(devices) {
    originalUpdateDeviceList(devices);
    var list = document.getElementById('device-list');
    if (!list) return;
    var items = list.querySelectorAll('li');
    items.forEach(function(li) {
      var deviceName = li.querySelector('span') ? li.querySelector('span').innerText : '';
      if (!deviceName) return;
      var device = devices.find(function(d) { return d.device === deviceName; });
      if (!device) return;
      var isRes = (device.type && device.type.toLowerCase().trim() === 'reservoir') || deviceName.toLowerCase().includes('reservoir');
      var isPres = (device.type && device.type.toLowerCase().trim() === 'pressure') || deviceName.toLowerCase().includes('pressure');
      if (isRes) {
        injectAnomalyBadge(li, deviceName, device.level, true);
      } else if (isPres) {
        injectAnomalyBadge(li, deviceName, device.pressure, false);
      }
    });
  };

  var originalUpdateDashboard = window.updateDashboard;
  window.updateDashboard = function() {
    originalUpdateDashboard();
    apiGet('getDashboardData').then(function(devices) {
      updateMaintenanceScore(devices);
      trainIFModel(devices);
    }).catch(function(e) { console.warn('Maintenance score update failed', e); });
  };

  var originalShowDeviceDetails = window.showDeviceDetails;
  window.showDeviceDetails = function(device) {
    originalShowDeviceDetails(device);
    setTimeout(function() {
      var det = document.getElementById('device-details');
      if (!det) return;
      var maintHtml = buildMaintenanceBadge(device);
      if (maintHtml) {
        var existing = det.querySelector('.ai-maint-badge');
        if (existing) existing.remove();
        var div = document.createElement('div');
        div.className = 'ai-maint-badge';
        div.innerHTML = maintHtml;
        det.appendChild(div);
      }
    }, 100);
  };

  var originalRenderRangeChart = window.renderRangeChart;
  window.renderRangeChart = function() {
    originalRenderRangeChart();
    injectForecastDataset();
  };

  var originalLogin = window.login;
  if (originalLogin) {
    window.login = function() {
      var result = originalLogin.apply(this, arguments);
      setTimeout(function() {
        var fab = document.getElementById('ai-chat-fab');
        if (fab) fab.style.display = 'flex';
      }, 1000);
      return result;
    };
  }
})();

// ============================================================
// AI-Driven Analytics Report Generator
// ============================================================
function generateAIReport() {
  var aiSection = document.getElementById('tab-modal-ai-section');
  var aiOutput = document.getElementById('ai-report-output');
  var aiSpinner = document.getElementById('ai-report-spinner');
  if (!aiSection || !aiOutput) return;

  aiSection.style.display = 'block';
  aiOutput.innerHTML = '';
  if (aiSpinner) aiSpinner.style.display = 'flex';

  // Gather all devices data
  apiGet('getDashboardData').then(function(devices) {
    var allFetches = devices
      .filter(function(d) {
        var n = (d.device||'').toLowerCase();
        return d.device && !n.endsWith('pressurelog') && !n.endsWith('reservoirlog');
      })
      .map(function(d) {
        return apiGet('getSheetData', { sheet: d.device })
          .then(function(rows) { return { device: d, rows: rows || [] }; })
          .catch(function() { return { device: d, rows: [] }; });
      });

    Promise.all(allFetches).then(function(results) {
      // Build a rich summary for each device
      var sections = results.map(function(r) {
        var d = r.device;
        var rows = r.rows;
        var devType = 'Pumping Station';
        var n = (d.device||'').toLowerCase();
        var t = (d.type||'').toLowerCase();
        if (t==='reservoir'||n.includes('reservoir')) devType = 'Reservoir';
        else if (t==='pressure'||n.includes('pressure')) devType = 'Pressure Device';

        if (!rows.length) return '## ' + d.device + ' [' + devType + ']\n- No historical data available.\n- Current status: ' + (d.status||'Unknown');

        var keys = Object.keys(rows[0]);
        function colAvg(pat) {
          var k = keys.find(function(x){return pat.test(x);});
          if (!k) return null;
          var vals = rows.map(function(r){return parseFloat(r[k]);}).filter(function(v){return !isNaN(v)&&v>0;});
          if (!vals.length) return null;
          var avg = vals.reduce(function(a,b){return a+b;},0)/vals.length;
          var mx = Math.max.apply(null,vals), mn = Math.min.apply(null,vals);
          return { avg: avg.toFixed(2), max: mx.toFixed(2), min: mn.toFixed(2), count: vals.length };
        }
        var pressure = colAvg(/pressure|psi/i);
        var flow = colAvg(/flowrate|flow/i);
        var level = colAvg(/cubic\s*meter|cube|res.*water|water.*level|reservoir.*level|water.*volume|volume.*m3|level.*res|level.*water|water.*m3/i);
        var voltage = colAvg(/voltage/i);
        var current = colAvg(/current/i);
        var power = colAvg(/power/i);
        var energy = colAvg(/energy/i);
        var discharge = colAvg(/discharge/i);

        var lines = ['## ' + d.device + ' [' + devType + '] — ' + rows.length + ' records'];
        lines.push('- Status: ' + (d.status||'Unknown') + (d.relay!=null?' | Relay: '+(d.relay?'ON':'OFF'):''));
        if (pressure) lines.push('- Pressure: avg '+pressure.avg+' psi | max '+pressure.max+' | min '+pressure.min);
        if (flow)     lines.push('- Flowrate: avg '+flow.avg+' L/s | max '+flow.max+' | min '+flow.min);
        if (level)    lines.push('- Water Level: avg '+level.avg+' m³ | max '+level.max+' | min '+level.min);
        if (voltage)  lines.push('- Voltage: avg '+voltage.avg+' V | min '+voltage.min);
        if (current)  lines.push('- Current: avg '+current.avg+' A | max '+current.max);
        if (power)    lines.push('- Power: avg '+power.avg+' W | peak '+power.max);
        if (energy)   lines.push('- Total Energy: '+energy.avg+' kWh avg | max '+energy.max);
        if (discharge)lines.push('- Discharge: avg '+discharge.avg+' m³ | total records: '+discharge.count);

        // Fault & offline events
        var faults = rows.filter(function(r){ var s=(r.status||r.Status||'').toLowerCase(); return s==='fault'; }).length;
        var offline = rows.filter(function(r){ var s=(r.status||r.Status||'').toLowerCase(); return s==='offline'; }).length;
        if (faults||offline) lines.push('- Fault events: '+faults+' | Offline events: '+offline);

        return lines.join('\n');
      }).join('\n\n');

      // Build cross-device risk comparison matrix
      var riskRows = results.map(function(r) {
        var d = r.device;
        var rows = r.rows;
        var n = (d.device||'').toLowerCase();
        var t = (d.type||'').toLowerCase();
        var devType = (t==='reservoir'||n.includes('reservoir')) ? 'Reservoir' : (t==='pressure'||n.includes('pressure')) ? 'Pressure' : 'Pump Station';
        if (!rows.length) return { name: d.device, type: devType, status: d.status||'Unknown', riskTier: '—' };
        var keys = Object.keys(rows[0]);
        var vals = [];
        keys.forEach(function(k) {
          rows.forEach(function(rr){ var v=parseFloat(rr[k]); if(!isNaN(v)&&v>0) vals.push(v); });
        });
        var maxV = vals.length ? Math.max.apply(null, vals) : 0;
        var avgV = vals.length ? (vals.reduce(function(a,b){return a+b;},0)/vals.length) : 0;
        // Estimate risk tier from alarm status and relay state
        var faults = rows.filter(function(rr){ return (rr.status||rr.Status||'').toLowerCase()==='fault'; }).length;
        var offlines = rows.filter(function(rr){ return (rr.status||rr.Status||'').toLowerCase()==='offline'; }).length;
        var faultRatio = rows.length ? (faults+offlines)/rows.length : 0;
        var riskTier = faultRatio > 0.2 ? 'HIGH' : faultRatio > 0.05 ? 'MEDIUM' : 'LOW';
        var avgStr = avgV ? avgV.toFixed(1) : '—';
        return { name: d.device, type: devType, status: d.status||'Unknown', riskTier: riskTier, faults: faults, offlines: offlines, total: rows.length, avgVal: avgStr, maxVal: maxV.toFixed(1) };
      });

      var comparisonTable = riskRows.map(function(rr) {
        return '| ' + rr.name + ' | ' + rr.type + ' | ' + rr.status + ' | ' + rr.riskTier + ' | ' + rr.total + ' | ' + rr.avgVal + ' | ' + rr.maxVal + ' | ' + rr.faults + '/' + rr.offlines + ' |';
      }).join('\n');

      var comparisonHeader = '| Device | Type | Status | Risk Tier | Records | Avg Value | Peak Value | Faults/Offline |\n|-------|------|--------|----------|---------|-----------|------------|----------------|\n';

      var tabName = TAB_CONFIGS[tabModalCurrentTab] ? TAB_CONFIGS[tabModalCurrentTab].title.replace(/[^\w\s]/g,'').trim() : 'Analysis';
      var prompt = 'You are an AI analyst for AGUS (Autonomous Groundwater Utility System), a water utility SCADA platform.\n\n'
        + 'The user has requested an AI-driven ' + tabName + ' report. Below is aggregated real-time sensor data from ALL monitored devices:\n\n'
        + sections + '\n\n'
        + '--- CROSS-DEVICE COMPARISON ---\n'
        + comparisonHeader + comparisonTable + '\n\n'
        + 'Generate a comprehensive, structured operational report. Include:\n'
        + '1. **Executive Summary** (2-3 sentences on overall system health, mentioning highest-risk device)\n'
        + '2. **Pumping Station Analysis** — efficiency, energy use, pressure stability, fault events\n'
        + '3. **Pressure Device Analysis** — pressure trends, alarm risk, zone compliance\n'
        + '4. **Reservoir Analysis** — water level trends, storage adequacy, risk of overflow/depletion\n'
        + '5. **Cross-Device Risk Comparison** — which devices are most at risk and why (use the comparison table)\n'
        + '6. **Key Findings & Anomalies** — any devices needing immediate attention\n'
        + '7. **Actionable Recommendations** — 3-5 specific, numbered actions for operations staff\n\n'
        + 'Use plain English. Format with clear section headers. Be specific — cite device names and values.';

      return aiFetch({
        model: AI_MODEL,
        max_tokens: 1800,
        messages: [{ role: 'user', content: prompt }]
      });
    })
    .then(function(data) {
      if (aiSpinner) aiSpinner.style.display = 'none';
      var text = (data.content && data.content[0]) ? data.content[0].text.trim() : 'Unable to generate report.';
      // Render markdown-lite
      var html = text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/^#{1,3}\s(.+)$/gm, '<div style="font-weight:800;color:#002b5c;font-size:13px;margin:12px 0 4px;border-bottom:1px solid #d0e4f7;padding-bottom:3px;">$1</div>')
        .replace(/^\d+\.\s(.+)$/gm, '<div style="margin:4px 0 4px 14px;">• $1</div>')
        .replace(/^- (.+)$/gm, '<div style="margin:3px 0 3px 10px;color:#334155;">– $1</div>')
        .replace(/\n/g, '<br>');
      aiOutput.innerHTML = html;
    })
    .catch(function(err) {
      if (aiSpinner) aiSpinner.style.display = 'none';
      aiOutput.innerHTML = '<span style="color:#e05555;">⚠ AI report failed: ' + (err.message||err) + '</span>';
    });
  }).catch(function(err) {
    if (aiSpinner) aiSpinner.style.display = 'none';
    if (aiOutput) aiOutput.innerHTML = '<span style="color:#e05555;">⚠ Failed to load device data: '+(err.message||err)+'</span>';
  });
}

// ============================================================
// KPI AI Insight
// ============================================================
function genKPIInsight(stats) {
  var out = document.getElementById('kpi-ai-output');
  if (!out) return;
  out.innerHTML = '<div class="spinner" style="width:20px;height:20px;border-width:2px;display:inline-block;"></div> Generating…';
  aiCall('You are the AI advisor for AGUS water utility.', 'System KPIs right now:\n'
      +'- Uptime: '+stats.uptime+'%  Faults: '+stats.faults+'  Offline: '+stats.offline+'\n'
      +'- Pumps running: '+stats.pumpsOn+'  Total flow: '+stats.totalFlow+' L/s\n'
      +'- Total power: '+stats.totalPower+' W  Energy: '+stats.totalEnergy+' kWh\n'
      +'- Avg pressure: '+stats.avgPres+' psi  Avg reservoir: '+stats.avgLevel+' m³\n\n'
      +'Give a 3-bullet operational commentary with status assessment and top 2 action items. Be concise.'
    ).then(function(data){
    var t = data.content&&data.content[0]?data.content[0].text:'No response.';
    out.innerHTML = '<div style="background:#f0f8ff;border:1px solid #b8d9f5;border-radius:8px;padding:10px 14px;">🤖 '+t.replace(/\n/g,'<br>')+'</div>';
  }).catch(function(e){ out.innerHTML='<span style="color:#e05555;">AI error: '+e.message+'</span>'; });
}

// ============================================================
// MODULE: WATER QUALITY MONITOR
// ============================================================
var waterQualityData = JSON.parse(localStorage.getItem('agus_wq_data')||'{}');

function openWaterQuality() {
  var old = document.getElementById('wq-overlay'); if (old) old.remove();
  var ov = document.createElement('div');
  ov.id = 'wq-overlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,10,30,0.75);z-index:5500;display:flex;align-items:center;justify-content:center;';

  var stations = ['Station 1','Station 2','Station 3','Station 4'];
  var wqParams = [
    {key:'chlorine',label:'Chlorine Residual',unit:'mg/L',min:0.2,max:1.0,color:'#06b6d4'},
    {key:'turbidity',label:'Turbidity',unit:'NTU',min:0,max:1.0,color:'#8b5cf6'},
    {key:'ph',label:'pH',unit:'',min:6.5,max:8.5,color:'#22c55e'},
    {key:'tds',label:'TDS',unit:'mg/L',min:0,max:500,color:'#f97316'},
    {key:'temp',label:'Temperature',unit:'°C',min:0,max:35,color:'#ef4444'},
    {key:'ecoli',label:'E.Coli',unit:'CFU/100mL',min:0,max:0,color:'#dc2626'}
  ];

  function paramStatus(p, val) {
    var v = parseFloat(val);
    if (isNaN(v)) return {color:'#9ca3af',label:'—'};
    if (p.key==='ecoli') return v===0?{color:'#22c55e',label:'SAFE'}:{color:'#ef4444',label:'UNSAFE'};
    if (v < p.min || v > p.max) return {color:'#ef4444',label:'OUT OF RANGE'};
    if (p.key==='chlorine' && v < 0.4) return {color:'#f97316',label:'LOW'};
    if (p.key==='ph' && (v < 7.0 || v > 8.0)) return {color:'#f97316',label:'CAUTION'};
    return {color:'#22c55e',label:'NORMAL'};
  }

  var stationHTML = stations.map(function(st) {
    var d = waterQualityData[st] || {};
    var rows = wqParams.map(function(p) {
      var v = d[p.key]||''; var st2 = paramStatus(p, v);
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid #f0f4f9;">'
        +'<span style="font-size:12px;color:#334155;">'+p.label+'</span>'
        +'<div style="display:flex;align-items:center;gap:8px;">'
        +'<input type="number" step="0.01" placeholder="'+p.min+'–'+p.max+' '+p.unit+'" value="'+(v||'')+'" onchange="saveWQValue(\''+st+'\',\''+p.key+'\',this.value)" style="width:90px;padding:3px 7px;border:1.5px solid #d0e4f7;border-radius:6px;font-size:12px;outline:none;"> <span style="font-size:11px;color:#94a3b8;">'+p.unit+'</span>'
        +'<span style="background:'+st2.color+'22;color:'+st2.color+';border-radius:10px;padding:2px 8px;font-size:10px;font-weight:700;min-width:60px;text-align:center;">'+st2.label+'</span>'
        +'</div></div>';
    }).join('');
    var lastUpdated = d._time ? 'Last updated: '+d._time : 'No data entered yet';
    return '<div style="background:#f8fbff;border:1.5px solid #d0e4f7;border-radius:12px;padding:14px 16px;">'
      +'<div style="font-weight:700;color:#002b5c;margin-bottom:2px;">💧 '+st+'</div>'
      +'<div style="font-size:11px;color:#94a3b8;margin-bottom:10px;">'+lastUpdated+'</div>'
      +rows+'</div>';
  }).join('');

  ov.innerHTML = '<div style="background:#fff;border-radius:18px;width:880px;max-width:96vw;max-height:92vh;overflow-y:auto;box-shadow:0 24px 70px rgba(0,0,0,0.45);display:flex;flex-direction:column;">'
    +'<div style="background:linear-gradient(135deg,#0369a1,#0ea5e9);padding:16px 20px;display:flex;align-items:center;justify-content:space-between;border-radius:18px 18px 0 0;flex-shrink:0;">'
    +'<div><div style="color:#fff;font-weight:800;font-size:1.15rem;">🧪 Water Quality Monitor</div><div style="color:rgba(255,255,255,0.75);font-size:12px;margin-top:2px;">WHO/NSF standards — chlorine, turbidity, pH, TDS, temperature, E.Coli</div></div>'
    +'<button onclick="document.getElementById(\'wq-overlay\').remove()" style="background:rgba(255,255,255,0.15);border:none;color:#fff;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer;">✕</button>'
    +'</div>'
    +'<div style="padding:16px 18px;flex:1;">'
    +'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px;">'+stationHTML+'</div>'
    +'<div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;">'
    +'<button onclick="genWQReport()" style="padding:7px 18px;background:linear-gradient(135deg,#004080,#0077cc);color:white;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">🤖 AI Water Quality Analysis</button>'
    +'</div>'
    +'<div id="wq-ai-output" style="margin-top:12px;font-size:13px;color:#1e293b;line-height:1.6;"></div>'
    +'</div></div>';
  ov.addEventListener('click', function(e){ if(e.target===ov) ov.remove(); });
  document.body.appendChild(ov);
}

function saveWQValue(station, param, val) {
  if (!waterQualityData[station]) waterQualityData[station]={};
  waterQualityData[station][param] = val;
  waterQualityData[station]._time = new Date().toLocaleString();
  localStorage.setItem('agus_wq_data', JSON.stringify(waterQualityData));
}

function genWQReport() {
  var out = document.getElementById('wq-ai-output'); if (!out) return;
  out.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;display:inline-block;"></div> Analyzing water quality…';
  var summary = Object.keys(waterQualityData).map(function(st){
    var d = waterQualityData[st];
    return st+': Cl='+d.chlorine+' mg/L, pH='+d.ph+', Turbidity='+d.turbidity+' NTU, TDS='+d.tds+' mg/L, Temp='+d.temp+'°C, EColi='+d.ecoli;
  }).join('\n');
  aiCall('You are a water quality analyst for AGUS water utility.',
    'Data:\n'+summary+'\n\nProvide:\n1. Compliance status (WHO/Philippine PNSDW standards)\n2. Any parameters out of safe range and health risk\n3. Recommended corrective actions\n4. Overall water safety verdict. Be specific and concise.'
  ).then(function(data){
    var t=data.content&&data.content[0]?data.content[0].text:'No response.';
    out.innerHTML='<div style="background:#f0f8ff;border:1px solid #b8d9f5;border-radius:8px;padding:10px 14px;">🤖 '+t.replace(/\n/g,'<br>')+'</div>';
  }).catch(function(e){out.innerHTML='<span style="color:#e05555;">Error: '+e.message+'</span>';});
}

// ============================================================
// Water Balance and NRW
// ============================================================
function genNRWReport(pumped, stored, nrw) {
  var out = document.getElementById('wl-ai-output'); if (!out) return;
  out.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px;display:inline-block;"></div> Analyzing…';
  aiCall('AGUS water utility NRW analysis.',
    'Total pumped: '+pumped+' m³\nTotal stored in reservoirs: '+stored+' m³\nEstimated NRW: '+nrw+'%\n\nProvide:\n1. NRW assessment vs IWA benchmarks\n2. Likely causes of water loss at this level\n3. Three prioritized actions to reduce NRW\n4. Financial impact estimate. Be concise and practical.'
  ).then(function(data){
    var t=data.content&&data.content[0]?data.content[0].text:'';
    out.innerHTML='<div style="background:#f5f0ff;border:1px solid #c4b5fd;border-radius:8px;padding:10px 14px;">🤖 '+t.replace(/\n/g,'<br>')+'</div>';
  }).catch(function(e){out.innerHTML='<span style="color:#e05555;">Error: '+e.message+'</span>';});
}

// ============================================================
// Comparative Benchmarking AI Insight
// ============================================================
function genBenchmarkInsight() {
  var out=document.getElementById('bench-ai-out'); if(!out||!window._benchSummary) return;
  out.innerHTML='<div class="spinner" style="width:18px;height:18px;border-width:2px;display:inline-block;"></div> Analyzing…';
  var s=window._benchSummary;
  var summary=s.metrics.filter(function(m){return m.current||m.prior;}).map(function(m){return m.label+': current='+m.current+' / prior='+m.prior;}).join('\n');
  aiCall('Performance trend analysis.', 'Analyze performance trends for AGUS device "'+s.device+'" comparing last '+s.days+' days vs prior '+s.days+' days:\n'+summary+'\n\nProvide:\n1. Key improvements and declines\n2. Possible operational causes\n3. Two recommendations. Concise.'
  ).then(function(data){
    var t=data.content&&data.content[0]?data.content[0].text:'';
    out.innerHTML='<div style="background:#f0f5ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;">🤖 '+t.replace(/\n/g,'<br>')+'</div>';
  }).catch(function(e){out.innerHTML='<span style="color:#e05555;">Error: '+e.message+'</span>';});
}

// ============================================================
// ML AI Interpretation
// ============================================================
function genMLAIInterpretation() {
  if (!_mlResults || !_mlResults.length) {
    showNotification('Run ML analysis first by selecting a device.', 'info');
    return;
  }
  var deviceSel = document.getElementById('ml-device-sel');
  var device = deviceSel ? deviceSel.value : 'Unknown Device';
  var insight = document.getElementById('ml-ai-insight');
  if (!insight) return;
  insight.style.display = 'block';
  insight.innerHTML = '<div id="ml-ai-insight"><div style="display:flex;align-items:center;gap:10px;"><div class="spinner" style="width:18px;height:18px;border-width:2px;flex-shrink:0;"></div><span style="color:#5575a0;font-size:13px;">Interpreting ML signals with DeepSeek AI…</span></div></div>';

  // Build a rich summary of ML findings for the AI
  var summary = _mlResults.map(function(a) {
    var riskLvl = a.riskScore >= 70 ? 'CRITICAL' : a.riskScore >= 50 ? 'AT RISK' : a.riskScore >= 25 ? 'WATCH' : 'SAFE';
    return '• ' + a.label + ' (' + a.unit + '): risk=' + a.riskScore + '/100 [' + riskLvl + ']'
      + ', trend slope=' + a.slope.toFixed(5) + '/reading'
      + ', R²=' + (a.r2 * 100).toFixed(1) + '%'
      + ', volatility(CV)=' + (a.cv * 100).toFixed(1) + '%'
      + ', IQR outliers=' + a.iqr.outlierCount + '/' + a.n
      + ', latest z-score=' + a.zMax + 'σ'
      + ', mean=' + a.mean + ' ' + a.unit
      + ', trend acceleration=' + (a.trendAccel >= 0 ? '+' : '') + (a.trendAccel || 0).toFixed(5) + '/reading²'
      + ', seasonality deviation=' + (a.seasonalityDev || 0).toFixed(3) + 'σ'
      + (a.rul !== null ? ', est. RUL=' + (a.rul === 0 ? 'EXCEEDED' : a.rul + 'd') : '');
  }).join('\n');

  var prompt = 'You are a predictive maintenance AI engineer for AGUS water utility SCADA system.\n\n'
    + 'I have run a machine learning analysis on device "' + device + '" using:\n'
    + '- Linear regression (slope + R² confidence)\n'
    + '- Trend acceleration (second derivative — momentum detection)\n'
    + '- IQR-based outlier detection\n'
    + '- Seasonality deviation (latest value vs IQR core range)\n'
    + '- Coefficient of Variation (volatility)\n'
    + '- Z-score deviation of latest reading\n'
    + '- Estimated Remaining Useful Life (linear projection)\n\n'
    + 'ML RESULTS:\n' + summary + '\n\n'
    + 'Provide a structured maintenance interpretation with:\n'
    + '1. **Risk Summary** — which parameters are most concerning and why\n'
    + '2. **Root Cause Hypotheses** — what the ML signals suggest about underlying issues\n'
    + '3. **Prioritised Actions** — 3 specific maintenance actions ranked by urgency\n'
    + '4. **Monitoring Recommendation** — which parameter to watch most closely and at what threshold\n\n'
    + 'Be specific, cite the ML values, and use plain language suitable for pump station operators.';

  aiFetch({ model: AI_MODEL, max_tokens: 900, messages: [{ role: 'user', content: prompt }] }).then(function(data) {
    var text = data.content && data.content[0] ? data.content[0].text : 'Unable to generate interpretation.';
    var html = text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,3}\s(.+)$/gm, '<div style="font-weight:800;color:#1e3a5f;font-size:13px;margin:10px 0 4px;border-bottom:1px solid #bfdbfe;padding-bottom:2px;">$1</div>')
      .replace(/^\d+\.\s(.+)$/gm, '<div style="margin:5px 0 5px 12px;color:#1e293b;">$1</div>')
      .replace(/^- (.+)$/gm, '<div style="margin:3px 0 3px 10px;color:#334155;">– $1</div>')
      .replace(/\n/g, '<br>');
    insight.innerHTML = '<div id="ml-ai-insight">'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">'
      +   '<span style="font-size:18px;">🤖</span>'
      +   '<span style="font-weight:800;color:#1e3a5f;font-size:13px;">AI Maintenance Interpretation</span>'
      +   '<span style="font-size:10px;color:#7a8fa6;margin-left:auto;">Based on ML analysis of ' + _mlResults.length + ' parameters</span>'
      + '</div>'
      + html
      + '</div>';
  }).catch(function(e) {
    insight.innerHTML = '<span style="color:#e05555;">AI interpretation error: ' + e.message + '</span>';
  });
}

// ============================================================
// Predictive Maintenance Scheduler
// ============================================================
function autoScheduleMaintenance(analysed) {
  if (!analysed || !analysed.length || typeof maintTasks === 'undefined') return;
  var scheduled = 0;
  analysed.forEach(function(a) {
    if (a.rul !== null && a.rul <= 14 && a.riskScore >= 50) {
      var existing = maintTasks.filter(function(t) {
        return t.device === (document.getElementById('ml-device-sel') ? document.getElementById('ml-device-sel').value : '') && t.task.indexOf(a.label) >= 0;
      });
      if (existing.length) return;
      var dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + Math.max(1, Math.min(14, a.rul)));
      var priority = a.riskScore >= 70 ? 'Critical' : a.riskScore >= 50 ? 'High' : 'Normal';
      maintTasks.push({
        id: Date.now() + Math.random(),
        device: document.getElementById('ml-device-sel') ? document.getElementById('ml-device-sel').value : 'Unknown',
        task: 'Predictive: ' + a.label + ' RUL=' + a.rul + 'd — inspection needed',
        dueDate: dueDate.toISOString().split('T')[0],
        priority: priority,
        status: 'Pending',
        createdBy: 'ML Engine',
        autoCreated: true
      });
      scheduled++;
    }
  });
  if (scheduled > 0) {
    maintTasks.sort(function(a,b){ return new Date(a.dueDate) - new Date(b.dueDate); });
    localStorage.setItem('agus_maint_tasks', JSON.stringify(maintTasks));
    var badge = document.getElementById('ml-risk-badge');
    if (badge) { badge.style.display = 'flex'; badge.textContent = scheduled; }
    showNotification('🔧 ML Engine auto-scheduled ' + scheduled + ' maintenance task(s) based on RUL analysis.', 'warning');
  }
}

// ============================================================
// AI ENHANCEMENTS — Top Cards, Map Health Card, Diagnostics
// ============================================================

/* ── 1. AI group label glow animation ── */
(function addAIGroupGlow() {
  var style = document.createElement('style');
  style.setAttribute('data-agus-trusted','1');
  style.textContent = [
    '@keyframes aiPulse{0%,100%{box-shadow:0 0 0 0 rgba(124,58,237,0.0);}50%{box-shadow:0 0 0 6px rgba(124,58,237,0.18);}}',
    '.grp-ai .nav-group-label{color:#7c3aed!important;font-weight:800!important;}',
    '.top-card.grp-ai{animation:aiPulse 3s ease-in-out infinite;}',
    '.top-card.grp-ai:hover{animation:none;}',
    /* AI Health Card on map */
    '#ai-health-card{position:absolute;top:120px;right:16px;z-index:1200;background:rgba(255,255,255,0.97);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1.5px solid rgba(124,58,237,0.22);border-radius:14px;padding:10px 14px;min-width:192px;box-shadow:0 6px 22px rgba(60,0,180,0.13);font-family:"DM Sans",sans-serif;cursor:pointer;transition:box-shadow .2s;}',
    '#ai-health-card:hover{box-shadow:0 8px 30px rgba(60,0,180,0.20);}',
    '#ai-health-score{font-size:28px;font-weight:800;line-height:1;}',
    '#ai-health-bar{height:5px;border-radius:3px;margin:5px 0 4px;overflow:hidden;background:#ede9fe;}',
    '#ai-health-fill{height:100%;border-radius:3px;transition:width .6s ease;}',
    /* Diagnostics panel */
    '#ai-diag-panel{display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:6500;width:540px;max-width:94vw;max-height:86vh;background:#fff;border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,0.42);overflow:hidden;flex-direction:column;}',
    '#ai-diag-panel.open{display:flex;}',
    '#ai-diag-body{flex:1;overflow-y:auto;padding:18px 22px;}',
    '.ai-diag-section{margin-bottom:16px;}',
    '.ai-diag-section h4{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:#5575a0;margin:0 0 8px;}',
    '.ai-diag-row{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-radius:8px;margin-bottom:4px;background:#f8fbff;font-size:12.5px;}',
    '.ai-diag-chip{border-radius:12px;padding:2px 10px;font-size:11px;font-weight:700;}',
    /* AI chat quick chips */
    '#ai-chat-chips{display:flex;gap:5px;flex-wrap:wrap;padding:8px 12px 4px;}',
    '.ai-chip-q{padding:4px 11px;background:#ede9fe;color:#5b21b6;border:1.5px solid #c4b5fd;border-radius:20px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;transition:.12s;}',
    '.ai-chip-q:hover{background:#ddd6fe;}'
  ].join('');
  document.head.appendChild(style);
})();

/* ── 2. AI System Health Card on map ── */
function _buildAIHealthCard() {
  var old = document.getElementById('ai-health-card');
  if (old) return; // already exists
  var mc = document.getElementById('map-container');
  if (!mc) return;
  var card = document.createElement('div');
  card.id = 'ai-health-card';
  card.title = 'Click to run AI System Diagnostics';
  card.onclick = openAIDiagnostics;
  card.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">'
    +'<div style="font-size:10px;font-weight:800;color:#7c3aed;text-transform:uppercase;letter-spacing:.6px;">🤖 AI Health Score</div>'
    +'<div style="width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.2);" id="ai-health-dot"></div>'
    +'</div>'
    +'<div id="ai-health-score" style="color:#7c3aed;">—</div>'
    +'<div id="ai-health-bar"><div id="ai-health-fill" style="width:0%;background:#7c3aed;"></div></div>'
    +'<div id="ai-health-label" style="font-size:11px;color:#64748b;margin-bottom:5px;">Initialising…</div>'
    +'<div style="font-size:10px;font-weight:700;color:#a78bfa;">▸ Click for AI Diagnostics</div>';
  mc.appendChild(card);
}

function _updateAIHealthCard(devices) {
  var scoreEl = document.getElementById('ai-health-score');
  var fillEl  = document.getElementById('ai-health-fill');
  var lblEl   = document.getElementById('ai-health-label');
  var dotEl   = document.getElementById('ai-health-dot');
  if (!scoreEl || !devices) return;
  var total   = devices.length || 1;
  var online  = devices.filter(function(d){ return (d.status||'').toLowerCase()==='online'; }).length;
  var fault   = devices.filter(function(d){ return (d.status||'').toLowerCase()==='fault'||d.button; }).length;
  var offline = devices.filter(function(d){ return (d.status||'').toLowerCase()==='offline'; }).length;
  var avgZ = 0, cnt = 0;
  devices.forEach(function(d) {
    var n = d.device + ':pressure', s = anomalyState[n];
    if (s && s.values.length > 1) { avgZ += Math.abs((s.values[s.values.length-1] - s.ema) / (Math.sqrt(s.emaVariance)||1)); cnt++; }
  });
  avgZ = cnt ? avgZ / cnt / 3 : 0;
  var ifScores = 0, ifCnt = 0;
  devices.forEach(function(d) {
    var s = getIFScore(d);
    if (s !== null) { ifScores += s; ifCnt++; }
  });
  var avgIF = ifCnt ? ifScores / ifCnt : 0;
  var maintScores = Object.keys(maintenanceData).map(function(k){return maintenanceData[k].lastScore;}).filter(function(v){return v>0;});
  var avgMaint = maintScores.length ? maintScores.reduce(function(a,b){return a+b;},0)/maintScores.length : 0;
  var blendedAnomaly = Math.min(1, (avgZ * 0.5) + (avgIF * 0.5));
  var score = computeHealthScore(online/total, fault/total, blendedAnomaly, avgMaint);
  var color = score >= 85 ? '#22c55e' : score >= 60 ? '#f97316' : '#ef4444';
  var label = score >= 85 ? 'System Healthy' : score >= 60 ? 'Attention Needed' : 'Critical Issues';
  scoreEl.textContent = score;
  scoreEl.style.color = color;
  if (fillEl) { fillEl.style.width = score + '%'; fillEl.style.background = color; }
  if (lblEl)  { lblEl.textContent = label + ' · ' + online + '/' + total + ' online'; lblEl.style.color = color; }
  if (dotEl)  { dotEl.style.background = color; dotEl.style.boxShadow = '0 0 0 3px '+color+'33'; }
}

/* ── 3. AI Diagnostics full panel ── */
function openAIDiagnostics() {
  var old = document.getElementById('ai-diag-panel');
  if (old) { old.classList.toggle('open'); return; }
  var panel = document.createElement('div');
  panel.id = 'ai-diag-panel';
  panel.innerHTML =
    '<div style="background:linear-gradient(135deg,#4c1d95,#7c3aed);padding:16px 20px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">'
    +'<div><div style="color:#fff;font-weight:800;font-size:1.1rem;">🤖 AI System Diagnostics</div>'
    +'<div style="color:rgba(255,255,255,.72);font-size:11px;margin-top:2px;">Live analysis · anomaly detection · recommendations</div></div>'
    +'<button onclick="document.getElementById(\'ai-diag-panel\').classList.remove(\'open\')" style="background:rgba(255,255,255,.15);border:none;color:#fff;width:30px;height:30px;border-radius:50%;font-size:16px;cursor:pointer;">✕</button>'
    +'</div>'
    +'<div id="ai-diag-body">'
    +'<div style="text-align:center;padding:48px 0;color:#7a8fa6;"><div class="spinner" style="margin:0 auto 14px;"></div>Running diagnostics…</div>'
    +'</div>'
    +'<div style="padding:12px 20px;border-top:1px solid #ede9fe;background:#faf5ff;display:flex;gap:8px;flex-wrap:wrap;flex-shrink:0;">'
    +'<button onclick="runAIDiagnostics()" style="padding:7px 16px;background:linear-gradient(135deg,#5b21b6,#7c3aed);color:white;border:none;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;">🔄 Re-run Diagnostics</button>'
    +'<button onclick="document.getElementById(\'ai-diag-panel\').classList.remove(\'open\')" style="margin-left:auto;padding:7px 16px;background:#ede9fe;color:#5b21b6;border:1.5px solid #c4b5fd;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;">Close</button>'
    +'</div>';
  document.body.appendChild(panel);
  setTimeout(function(){ panel.classList.add('open'); runAIDiagnostics(); }, 50);
}

function runAIDiagnostics() {
  var body = document.getElementById('ai-diag-body');
  if (!body) return;
  body.innerHTML = '<div style="text-align:center;padding:40px 0;color:#7a8fa6;"><div class="spinner" style="margin:0 auto 14px;"></div>Fetching device data…</div>';
  apiGet('getDashboardData').then(function(devices) {
    var online  = devices.filter(function(d){ return (d.status||'').toLowerCase()==='online'; });
    var fault   = devices.filter(function(d){ return (d.status||'').toLowerCase()==='fault'||d.button; });
    var offline = devices.filter(function(d){ return (d.status||'').toLowerCase()==='offline'; });
    var pres    = devices.filter(function(d){ var t=(d.type||'').toLowerCase(),n=(d.device||'').toLowerCase(); return t==='pressure'||n.includes('pressure'); });
    var res     = devices.filter(function(d){ var t=(d.type||'').toLowerCase(),n=(d.device||'').toLowerCase(); return t==='reservoir'||n.includes('reservoir'); });
    var pumps   = devices.filter(function(d){ var n=(d.device||'').toLowerCase(); return n.includes('pumping station')||n.includes('pump'); });
    var avgZ = 0, zc = 0;
    devices.forEach(function(d) {
      var n = d.device + ':pressure', s = anomalyState[n];
      if (s && s.values.length > 1) { avgZ += Math.abs((s.values[s.values.length-1] - s.ema) / (Math.sqrt(s.emaVariance)||1)); zc++; }
    });
    avgZ = zc ? avgZ / zc / 3 : 0;
    var ifS = 0, ifC = 0;
    devices.forEach(function(d) { var s2 = getIFScore(d); if (s2 !== null) { ifS += s2; ifC++; } });
    var avgIF2 = ifC ? ifS / ifC : 0;
    var blendedAnom = Math.min(1, (avgZ * 0.5) + (avgIF2 * 0.5));
    var score   = computeHealthScore(online.length/devices.length, fault.length/devices.length, blendedAnom, 0);
    var scoreColor = score>=85?'#22c55e':score>=60?'#f97316':'#ef4444';

    function diagRow(icon, label, value, status, statusColor) {
      return '<div class="ai-diag-row">'
        +'<span>'+icon+' <span style="font-weight:600;color:#002b5c;">'+label+'</span></span>'
        +'<div style="display:flex;align-items:center;gap:8px;">'
        +'<span style="font-weight:700;color:#334155;">'+value+'</span>'
        +'<span class="ai-diag-chip" style="background:'+statusColor+'18;color:'+statusColor+';">'+status+'</span>'
        +'</div></div>';
    }

    var html = '';
    // Health score banner
    html += '<div style="background:linear-gradient(135deg,'+scoreColor+'12,'+scoreColor+'06);border:1.5px solid '+scoreColor+'44;border-radius:12px;padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;gap:16px;">'
      +'<div style="font-size:40px;font-weight:800;color:'+scoreColor+';">'+score+'</div>'
      +'<div><div style="font-weight:800;color:#002b5c;font-size:14px;">Overall System Health</div>'
      +'<div style="font-size:12px;color:#64748b;margin-top:2px;">'+online.length+'/'+devices.length+' devices online · '+fault.length+' fault(s) · '+offline.length+' offline</div>'
      +'<div style="height:6px;border-radius:3px;background:#f0f0f0;margin-top:6px;overflow:hidden;"><div style="height:100%;width:'+score+'%;background:'+scoreColor+';border-radius:3px;"></div></div>'
      +'</div></div>';

    // Device status section
    html += '<div class="ai-diag-section"><h4>Device Status</h4>';
    html += diagRow('🖥️','Total Devices', devices.length, 'All', '#64748b');
    html += diagRow('🟢','Online', online.length, online.length===devices.length?'All Clear':online.length+'/'+devices.length, '#22c55e');
    if (fault.length) html += diagRow('🔴','Fault', fault.length, fault.map(function(d){return d.device;}).join(', '), '#ef4444');
    if (offline.length) html += diagRow('🟠','Offline', offline.length, offline.map(function(d){return d.device;}).join(', '), '#f97316');
    html += '</div>';

    // Per-category metrics
    if (pres.length) {
      var avgP = (pres.reduce(function(s,d){return s+parseFloat(d.pressure||0);},0)/pres.length).toFixed(1);
      var presOk = pres.filter(function(d){ return (d.pressureStatus||'normal').toLowerCase()==='normal'; }).length;
      html += '<div class="ai-diag-section"><h4>Pressure Devices ('+pres.length+')</h4>';
      html += diagRow('📊','Avg Pressure', avgP+' psi', presOk===pres.length?'Normal':'Check Required', presOk===pres.length?'#22c55e':'#f97316');
      html += '</div>';
    }
    if (res.length) {
      var avgL = (res.reduce(function(s,d){return s+parseFloat(d.level||0);},0)/res.length).toFixed(1);
      html += '<div class="ai-diag-section"><h4>Reservoirs ('+res.length+')</h4>';
      html += diagRow('💧','Avg Water Level', avgL+' m³', 'Monitoring', '#06b6d4');
      html += '</div>';
    }
    if (pumps.length) {
      var pumpsOn = pumps.filter(function(d){return d.relay==1||d.relay==='1'||d.relay===true;}).length;
      var totalFlow = pumps.reduce(function(s,d){return s+parseFloat(d.flow||0);},0).toFixed(1);
      var totalPow  = pumps.reduce(function(s,d){return s+parseFloat(d.power||0);},0).toFixed(0);
      html += '<div class="ai-diag-section"><h4>Pump Stations ('+pumps.length+')</h4>';
      html += diagRow('⚙️','Pumps Running', pumpsOn+'/'+pumps.length, pumpsOn>0?'Active':'All Stopped', pumpsOn>0?'#22c55e':'#f97316');
      html += diagRow('💧','Total Flow', totalFlow+' L/s', 'Live', '#0ea5e9');
      html += diagRow('⚡','Total Power', totalPow+' W', 'Live', '#f97316');
      html += '</div>';
    }

    // Isolation Forest unsupervised anomaly detection
    var ifFeatures = [];
    var ifKeys = [];
    devices.forEach(function(d) {
      var p = parseFloat(d.pressure) || 0;
      var f = parseFloat(d.flow) || 0;
      var w = parseFloat(d.power) || 0;
      var v = parseFloat(d.voltage) || 0;
      var l = parseFloat(d.level) || 0;
      if (p || f || w || v || l) {
        ifFeatures.push([p, f, w / 1000, v / 100, l / 10]);
        ifKeys.push(d.device);
      }
    });
    if (ifFeatures.length >= 4) {
      var ifModel = new IsolationForest(30, Math.min(ifFeatures.length, 32));
      ifModel.train(ifFeatures);
      var ifResults = ifFeatures.map(function(f, i) { return { device: ifKeys[i], score: ifModel.score(f) }; });
      ifResults.sort(function(a, b) { return b.score - a.score; });
      var ifAnomalous = ifResults.filter(function(r) { return r.score > 0.6; });
      if (ifAnomalous.length) {
        html += '<div class="ai-diag-section"><h4>🔬 Isolation Forest Anomaly Detection</h4>';
        ifAnomalous.forEach(function(r) {
          var c = r.score > 0.75 ? '#ef4444' : '#f97316';
          html += diagRow('⚠️', r.device, (r.score * 100).toFixed(0) + '%', r.score > 0.75 ? 'Critical' : 'Elevated', c);
        });
        html += '</div>';
      }
    }

    // AI Recommendations section
    html += '<div class="ai-diag-section"><h4>🤖 AI Recommendations</h4>'
      +'<div id="ai-diag-recs" style="background:#faf5ff;border:1.5px solid #ede9fe;border-radius:10px;padding:12px 14px;font-size:12.5px;color:#1e293b;line-height:1.7;">'
      +'<div class="spinner" style="width:18px;height:18px;border-width:2px;display:inline-block;margin-right:8px;"></div> Generating AI recommendations…</div>'
      +'</div>';

    body.innerHTML = html;
    _updateAIHealthCard(devices);

    // Now generate AI recommendations
    var prompt = 'You are the AI diagnostics engine for AGUS (Autonomous Groundwater Utility System).\n\n'
      +'System snapshot:\n'
      +'- '+devices.length+' total devices: '+online.length+' online, '+fault.length+' fault, '+offline.length+' offline\n'
      +(pres.length?'- Pressure devices: '+(pres.reduce(function(s,d){return s+parseFloat(d.pressure||0);},0)/pres.length).toFixed(1)+' psi avg\n':'')
      +(res.length?'- Reservoirs: '+(res.reduce(function(s,d){return s+parseFloat(d.level||0);},0)/res.length).toFixed(1)+' m³ avg level\n':'')
      +(pumps.length?'- Pump stations: '+(pumps.filter(function(d){return d.relay==1;}).length)+'/'+pumps.length+' running, '+(pumps.reduce(function(s,d){return s+parseFloat(d.flow||0);},0).toFixed(1))+' L/s total flow\n':'')
      +(fault.length?'- FAULT devices: '+fault.map(function(d){return d.device;}).join(', ')+'\n':'')
      +(offline.length?'- OFFLINE devices: '+offline.map(function(d){return d.device;}).join(', ')+'\n':'')
      +'\nProvide 3 concise, numbered, actionable recommendations for operations staff. Each recommendation max 2 sentences. Focus on the most critical issues first. Use plain English.';

    aiCall('You are the AGUS AI diagnostics engine.', prompt).then(function(data) {
      var t = data.content&&data.content[0]?data.content[0].text.trim():'No recommendations available.';
      var recEl = document.getElementById('ai-diag-recs');
      if (recEl) {
        recEl.innerHTML = t
          .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
          .replace(/^\d+\.\s(.+)$/gm,'<div style="margin:6px 0;display:flex;gap:8px;"><span style="font-weight:800;color:#7c3aed;flex-shrink:0;">▸</span><span>$1</span></div>')
          .replace(/\n/g,'<br>');
      }
    }).catch(function(err) {
      var recEl = document.getElementById('ai-diag-recs');
      if (recEl) recEl.innerHTML = '<span style="color:#94a3b8;">⚠ AI offline — configure API key in AI Config for live recommendations.</span>';
    });
  }).catch(function(e) {
    body.innerHTML = '<p style="color:#ef4444;padding:20px;">⚠ Failed to load device data: '+(e.message||e)+'</p>';
  });
}

/* ── 4. Quick-question chips in AI Chat ── */
(function addAIChatChips() {
  function _inject() {
    var panel = document.getElementById('ai-chat-panel');
    if (!panel || document.getElementById('ai-chat-chips')) return;
    var chips = document.createElement('div');
    chips.id = 'ai-chat-chips';
    var questions = [
      'System status?',
      'Any alarms?',
      'Highest pressure?',
      'Lowest reservoir?',
      'Energy usage?'
    ];
    chips.innerHTML = questions.map(function(q) {
      return '<button class="ai-chip-q" onclick="document.getElementById(\'ai-chat-input\').value=\''+q+'\';sendAIMessage();">'+q+'</button>';
    }).join('');
    var msgBox = document.getElementById('ai-chat-messages');
    if (msgBox && msgBox.parentNode) {
      msgBox.parentNode.insertBefore(chips, msgBox.nextSibling);
    }
  }
  _inject();
  setTimeout(_inject, 2000);
})();

/* ── 5. Hook into dashboard update to refresh AI health card ── */
(function patchDashboardForAIHealth() {
  var _origUpdate = window.updateDashboard;
  window.updateDashboard = function() {
    if (_origUpdate) _origUpdate.apply(this, arguments);
    _buildAIHealthCard();
    apiGet('getDashboardData').then(function(devices) {
      _updateAIHealthCard(devices);
    }).catch(function(){});
  };
  var _origLogin = window.login;
  if (_origLogin) {
    window.login = function() {
      var r = _origLogin.apply(this, arguments);
      setTimeout(function() { _buildAIHealthCard(); }, 1500);
      return r;
    };
  }
})();

/* ── 6. On load — restore AI key status dot if key already stored ── */
(function restoreAIKeyStatusOnLoad() {
  var storedKey = localStorage.getItem('agus_ai_api_key') || '';
  if (storedKey) {
    var dot = document.getElementById('ai-key-status-dot');
    if (dot) dot.style.display = 'block';
    var lbl = document.getElementById('ai-config-lbl');
    if (lbl) lbl.textContent = 'AI Active';
  }
})();


