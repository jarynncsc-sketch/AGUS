/* AGUS Service Worker — pump-link auto-control + push notifications
   Supports background operation even when dashboard tabs are closed.
   Config is received via postMessage and persisted in IndexedDB.
   FIXED: Conflict resolution — Manual > Schedule > Pump-Link priority.
   NEW IndexedDB keys: pl_sch_cool, pl_cmd_pend (now written), pl_hist (4 samples), pl_state_src */
'use strict';
/* ═══════════════ IndexedDB helpers ═══════════════ */
function dbOpen(){return new Promise(function(res,rej){
  var r=indexedDB.open("agus_sw",1);
  r.onupgradeneeded=function(e){e.target.result.createObjectStore("kv");};
  r.onsuccess=function(e){res(e.target.result);};
  r.onerror=function(e){rej(e);};
});}
function dbGet(db,k){return new Promise(function(res,rej){
  var tx=db.transaction("kv","readonly"),r=tx.objectStore("kv").get(k);
  r.onsuccess=function(){res(r.result);};r.onerror=rej;
});}
function dbSet(db,k,v){return new Promise(function(res,rej){
  var tx=db.transaction("kv","readwrite"),r=tx.objectStore("kv").put(v,k);
  r.onsuccess=res;r.onerror=rej;
});}
/* ═══════════════ Cache helpers ═══════════════ */
var _dd={};var COOL=30000;
function can(k){var n=Date.now();if(_dd[k]&&n-_dd[k]<COOL)return false;_dd[k]=n;return true;}
var _swErr=0;
var _bgPollBusy=false;
/* ── Tag-prefix to NDRRMC alarm type map ── */
var _alarmMap = {
  'fault':'fault','off':'offline',
  'wl-hi':'high','wl-lo':'low',
  'psi-hi':'high pressure','psi-lo':'low pressure',
  'fl-hi':'high flow','fl-lo':'low flow',
  'vt-hi':'high voltage','vt-lo':'low voltage',
  'am-hi':'overcurrent','am-lo':'low current',
  'pw-hi':'high power'
};
/* ═══════════════ Notification helper ═══════════════ */
function pop(title,body,tag,urgent){
  var ttsMsg = title + ". " + body;
  if (urgent) {
    self.clients.matchAll({type:"window",includeUncontrolled:true}).then(function(cs){
      var parts = (tag||'').split(':');
      var devName = parts.slice(1).join(':') || '';
      var alarmType = _alarmMap[parts[0]] || parts[0];
      cs.forEach(function(c){
        if (c.url) { c.focus().catch(function(){}); }
        if (devName && parts[0] !== 'pl') {
          c.postMessage({type:"AGUS_NDRRMC",deviceName:devName,alarmType:alarmType,value:body,isReservoir:!!(parts[0]==='wl-hi'||parts[0]==='wl-lo'),key:devName+':'+alarmType});
        } else {
          c.postMessage({type:"AGUS_SPEAK",text:ttsMsg});
        }
      });
    }).catch(function(){});
  }
  return self.registration.showNotification(title,{
    body:body,tag:tag,requireInteraction:!!urgent,
    vibrate:urgent?[400,150,800,150,400,100,400]:[200,100,200],
    data:{tts:ttsMsg,tag:tag,urgent:!!urgent},
    icon:"data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ccircle cx=%2250%22 cy=%2250%22 r=%2245%22 fill=%22%23007bff%22/%3E%3Cpath d=%22M50 20C35 40 30 55 30 65a20 20 0 0 0 40 0c0-10-5-25-20-45z%22 fill=%22%23fff%22 opacity=%220.9%22/%3E%3C/svg%3E",
    badge:"data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ccircle cx=%2250%22 cy=%2250%22 r=%2245%22 fill=%22%23007bff%22/%3E%3Cpath d=%22M50 20C35 40 30 55 30 65a20 20 0 0 0 40 0c0-10-5-25-20-45z%22 fill=%22%23fff%22 opacity=%220.9%22/%3E%3C/svg%3E"
  });
}
/* ═══════════════ Background poll ═══════════════ */
async function bgPoll(){
  if(_bgPollBusy)return;_bgPollBusy=true;
  try{
    if(_swErr>5){_swErr=0;console.warn("[SW] Too many errors — skipping poll");return;}
    var db=await dbOpen();
    var cfg=await dbGet(db,"cfg");
    if(!cfg||!cfg.apiUrl||!cfg.token)return;
    var prev=(await dbGet(db,"prev"))||{};
    var url=cfg.apiUrl+"?action=getDashboardData&token="+encodeURIComponent(cfg.token);
    var res=await fetch(url);
    if(!res.ok)return;
    var devs=await res.json();
    if(!Array.isArray(devs))return;
    var ps=[];
    var DEF={minPsi:20,maxPsi:80,minLevel:20,maxLevel:250,minVolt:210,maxVolt:240,minCurrent:0,maxCurrent:30,minFlow:0.5,maxFlow:50,minPower:0,maxPower:15000};
    var thr={};try{thr=cfg.thr||{};}catch(e){}
    /* ★ NEW: Extract schedule cooldowns from dashboard data into IndexedDB */
    var schCool=(await dbGet(db,"pl_sch_cool"))||{};
    devs.forEach(function(d){
      var n=d.device||"",st=d.status||"",p=prev[n]||{},t=Object.assign({},DEF,thr[n]||{});
      /* ★ Store schedule cooldown if backend provided it */
      if(d.scheduleCooldownUntil&&d.scheduleCooldownUntil>Date.now()){
        schCool[n]=d.scheduleCooldownUntil;
      }
      if((st==="Fault"||d.button===1||d.button===true||d.button==="1")&&p.status!=="Fault"&&can("fault:"+n))
        ps.push(pop("⚠️ Fault — "+n,n+" FAULT detected. Immediate attention required.","fault:"+n,true));
      if(st==="Offline"&&p.status==="Online"&&can("off:"+n))
        ps.push(pop("📴 Offline — "+n,n+" went offline. Check connection.","off:"+n,true));
      if(st==="Online"&&(p.status==="Fault"||p.status==="Offline")&&can("ok:"+n))
        ps.push(pop("✅ Recovered — "+n,n+" is back online.","ok:"+n,false));
      var lv=parseFloat(d.level);
      if(!isNaN(lv)){
        if(lv>=t.maxLevel&&(p.lv==null||p.lv<t.maxLevel)&&can("wl-hi:"+n))
          ps.push(pop("🚰 Reservoir Full — "+n,n+" at "+lv.toFixed(1)+" m³ (max "+t.maxLevel+" m³). Pump may shut off.","wl-hi:"+n,true));
        if(lv<=t.minLevel&&(p.lv==null||p.lv>t.minLevel)&&can("wl-lo:"+n))
          ps.push(pop("💧 Low Water — "+n,n+" at "+lv.toFixed(1)+" m³ (min "+t.minLevel+" m³). Check supply.","wl-lo:"+n,true));
      }
      var psi=parseFloat(d.pressure);
      if(!isNaN(psi)){
        if(psi>t.maxPsi&&(p.psi==null||p.psi<=t.maxPsi)&&can("psi-hi:"+n))
          ps.push(pop("🔴 High Pressure — "+n,n+": "+psi.toFixed(1)+" psi > "+t.maxPsi+" psi. Check for blockage.","psi-hi:"+n,true));
        if(psi<t.minPsi&&psi>0&&(p.psi==null||p.psi>=t.minPsi)&&can("psi-lo:"+n))
          ps.push(pop("🟠 Low Pressure — "+n,n+": "+psi.toFixed(1)+" psi < "+t.minPsi+" psi. Check pump.","psi-lo:"+n,true));
      }
      var fl=parseFloat(d.flow);
      if(!isNaN(fl)&&d.relay==1){
        if(fl>t.maxFlow&&(p.fl==null||p.fl<=t.maxFlow)&&can("fl-hi:"+n))
          ps.push(pop("💦 High Flow — "+n,n+": "+fl.toFixed(2)+" L/s > "+t.maxFlow+" L/s. Possible pipe burst.","fl-hi:"+n,true));
        if(fl<t.minFlow&&fl>=0&&(p.fl==null||p.fl>=t.minFlow)&&can("fl-lo:"+n))
          ps.push(pop("⚠️ Low Flow — "+n,n+": "+fl.toFixed(2)+" L/s < "+t.minFlow+" L/s while pump ON.","fl-lo:"+n,true));
      }
      var vt=parseFloat(d.voltage);
      if(!isNaN(vt)&&vt>0){
        if(vt>t.maxVolt&&(p.vt==null||p.vt<=t.maxVolt)&&can("vt-hi:"+n))
          ps.push(pop("⚡ High Voltage — "+n,n+": "+vt.toFixed(1)+" V > "+t.maxVolt+" V. Risk of damage.","vt-hi:"+n,true));
        if(vt<t.minVolt&&(p.vt==null||p.vt>=t.minVolt)&&can("vt-lo:"+n))
          ps.push(pop("🔋 Low Voltage — "+n,n+": "+vt.toFixed(1)+" V < "+t.minVolt+" V. Power issue.","vt-lo:"+n,true));
      }
      var am=parseFloat(d.current);
      if(!isNaN(am)&&am>=0){
        if(am>t.maxCurrent&&(p.am==null||p.am<=t.maxCurrent)&&can("am-hi:"+n))
          ps.push(pop("⚡ Overcurrent — "+n,n+": "+am.toFixed(2)+" A > "+t.maxCurrent+" A. Motor overload!","am-hi:"+n,true));
        if(am<t.minCurrent&&t.minCurrent>0&&d.relay==1&&(p.am==null||p.am>=t.minCurrent)&&can("am-lo:"+n))
          ps.push(pop("⚠️ Low Current — "+n,n+": "+am.toFixed(2)+" A < "+t.minCurrent+" A while running.","am-lo:"+n,true));
      }
      var pw=parseFloat(d.power);
      if(!isNaN(pw)&&pw>t.maxPower&&(p.pw==null||p.pw<=t.maxPower)&&can("pw-hi:"+n))
        ps.push(pop("🔌 High Power — "+n,n+": "+pw.toFixed(0)+" W > "+t.maxPower+" W. Abnormal load.","pw-hi:"+n,true));
      prev[n]={status:st,relay:d.relay,lv:isNaN(lv)?p.lv:lv,psi:isNaN(psi)?p.psi:psi,fl:isNaN(fl)?p.fl:fl,vt:isNaN(vt)?p.vt:vt,am:isNaN(am)?p.am:am,pw:isNaN(pw)?p.pw:pw};
    });
    await dbSet(db,"prev",prev);
    await dbSet(db,"pl_sch_cool",schCool);
    await pumpLinkControl(cfg,devs,db,ps);
    await Promise.all(ps);
    _swErr=0;
  }catch(err){console.error("[SW] bgPoll:",err);_swErr++}
  finally{_bgPollBusy=false;}
  if(_swErr>5){_swErr=0;console.warn("[SW] Too many errors — skipping poll");return;}
}
/* ═══════════════ Error-type → cooldown mapping ═══════════════ */
var _ERR_COOL={
  'session':0,          /* token expired — don't lock, just skip */
  'manual_override':600000, /* 10 min — user just toggled manually */
  'auto_shutoff':0,     /* auto-shutoff active — don't lock, let next poll retry */
  'device_busy':30000,  /* 30s — device busy, retry soon */
  'network':60000,      /* 1 min — network error */
  'unknown':300000      /* 5 min — fallback */
};
function _cooldownForError(errType,errorMsg){
  /* Prefer explicit errorType from backend, fall back to string matching */
  if(errType&&_ERR_COOL.hasOwnProperty(errType))return _ERR_COOL[errType];
  if(!errorMsg)return 300000;
  var m=errorMsg.toLowerCase();
  if(m.indexOf('session')!==-1)return _ERR_COOL.session;
  if(m.indexOf('manual override')!==-1)return _ERR_COOL.manual_override;
  if(m.indexOf('auto')!==-1&&m.indexOf('shutoff')!==-1)return _ERR_COOL.auto_shutoff;
  if(m.indexOf('busy')!==-1)return _ERR_COOL.device_busy;
  if(m.indexOf('network')!==-1)return _ERR_COOL.network;
  return _ERR_COOL.unknown;
}
/* ═══════════════ Pump toggle helper ═══════════════ */
async function swTogglePump(apiUrl,token,device,desiredState){
  try{
    var qs = 'action=togglePump'
      + '&token=' + encodeURIComponent(token)
      + '&device=' + encodeURIComponent(device)
      + '&latitude=&longitude='
      + (desiredState !== undefined ? '&desiredState=' + encodeURIComponent(desiredState) : '')
      + '&triggeredBy=SW';
    var r=await fetch(apiUrl + '?' + qs);
    if(!r.ok)return null;return await r.json();
  }catch(e){console.warn("[SW] togglePump error:",e);return null;}
}
/* ═══════════════ Pump-link auto-control ═══════════════ */
async function pumpLinkControl(cfg,devs,db,ps){
  var links=cfg.pumpLinks||[];
  if(!links.length){
    try{
      var lr=await fetch(cfg.apiUrl+'?action=getPumpLinks&token='+encodeURIComponent(cfg.token));
      if(lr.ok){var ld=await lr.json();if(Array.isArray(ld)){links=ld;}}
    }catch(e){console.warn("[SW] getPumpLinks error:",e);}
  }
  if(!links.length)return;
  /* ★ FIX: If server-side trigger installed, defer entirely — don't fight it */
  if(cfg.gasTriggerInstalled){return;}
  var cool=(await dbGet(db,"pl_cool"))||{};
  var manCool=(await dbGet(db,"pl_man_cool"))||{};
  var schCool=(await dbGet(db,"pl_sch_cool"))||{};
  var cmdPend=(await dbGet(db,"pl_cmd_pend"))||{};
  var hist=(await dbGet(db,"pl_hist"))||{};
  var stateSrc=(await dbGet(db,"pl_state_src"))||{};
  var now=Date.now();var PL_COOL=300000;
  var devMap={};devs.forEach(function(d){devMap[d.device]=d;});
  var _reservoirSeen={};
  for(var i=0;i<links.length;i++){
    try{
    var lnk=links[i];
    if(!lnk.enabled)continue;
    if(lnk.manualOverride)continue;
    /* ★ FIX: Check manual cooldown (set by frontend _executeDashboardToggle) */
    if(manCool[lnk.pump]&&now<manCool[lnk.pump])continue;
    /* ★ FIX: Check in-flight command lock (set by frontend or by this SW before sending) */
    if(cmdPend[lnk.pump]&&now<cmdPend[lnk.pump])continue;
    /* ★ NEW: Check schedule cooldown (set by backend runScheduledToggles via getDashboardData) */
    if(schCool[lnk.pump]&&now<schCool[lnk.pump])continue;
    var resD=devMap[lnk.reservoir],pumD=devMap[lnk.pump];
    if(!resD||!pumD)continue;
    var lv=parseFloat(resD.level);if(isNaN(lv))continue;
    /* Level history for resume dampening — expanded to 4 samples, only once per reservoir per poll */
    if(!_reservoirSeen[lnk.reservoir]){
      if(!hist[lnk.reservoir])hist[lnk.reservoir]=[];
      hist[lnk.reservoir].push(lv);
      while(hist[lnk.reservoir].length>4)hist[lnk.reservoir].shift();
      _reservoirSeen[lnk.reservoir]=true;
    }
    var sOff=parseFloat(lnk.shutoffLevel),sRes=parseFloat(lnk.resumeLevel);
    var sOff2=parseFloat(lnk.shutoffLevel2)||0,sRes2=parseFloat(lnk.resumeLevel2)||0;
    if(isNaN(sOff)||isNaN(sRes))continue;
    var pOn=pumD.commandedRelay==1||pumD.commandedRelay===true||pumD.relay==1||pumD.relay===true||pumD.relay==="1";
    var ck=lnk.pump;
    if(cool[ck]&&now<cool[ck])continue;
    var needOff=pOn&&(lv>=sOff||(sOff2>0&&lv>=sOff2));
    var needOn=!pOn&&(lv<=sRes||(sRes2>0&&lv<=sRes2));
    /* ★ FIX: Dampening — require 2 most-recent consecutive readings below resume before ON */
    if(needOn&&hist[lnk.reservoir]&&hist[lnk.reservoir].length>=2){
      var hLen=hist[lnk.reservoir].length;
      var last1=hist[lnk.reservoir][hLen-1];
      var last2=hist[lnk.reservoir][hLen-2];
      if(last1>sRes&&(sRes2===0||last1>sRes2))needOn=false;
      if(last2>sRes&&(sRes2===0||last2>sRes2))needOn=false;
    }
    /* Manual override gate — block both auto-ON and auto-OFF when user has manual control */
    if(pumD.manualOverrideActive){needOn=false;needOff=false;}
    if(!needOff&&!needOn)continue;
    var desiredState = needOff ? 0 : 1;
    /* ★ FIX: Set in-flight lock BEFORE sending the command */
    cmdPend[lnk.pump]=now+30000;
    var tr=await swTogglePump(cfg.apiUrl,cfg.token,lnk.pump,desiredState);
    /* ★ FIX: Clear in-flight lock after response */
    delete cmdPend[lnk.pump];
    if(!tr){
      /* ★ FIX: Error-driven cooldown — different durations for different failures */
      cool[ck]=now+_ERR_COOL.unknown;
      continue;
    }
    if(tr.error){
      /* ★ FIX: Use errorType field from backend when available, fall back to string matching */
      var errType = tr.errorType || null;
      if(errType==='session'||tr.error.indexOf("session")!==-1){
        console.warn("[SW] Token expired for",lnk.pump);
        /* Don't set cooldown — token issue, not device issue */
        continue;
      }
      /* Use error-driven cooldown based on errorType or string matching */
      var errCool = _cooldownForError(errType,tr.error);
      if(errCool>0){cool[ck]=now+errCool;}else{delete cool[ck];}
      continue;
    }
    if(tr.success){
      cool[ck]=now;
      var newOn=!!tr.newState;
      var lvStr=lv.toFixed(1)+" m³";
      var thresh=newOn?"resumed ≤"+sRes+" m³":"shut off ≥"+sOff+" m³";
      stateSrc[ck]="pump-link";
      ps.push(pop((newOn?"▶️ Auto-ON: ":"⏹️ Auto-OFF: ")+lnk.pump,
        lnk.reservoir+" "+thresh+". Level: "+lvStr,"pl:"+ck,true));
    }
    }catch(e){console.warn("[SW] pumpLink error for",lnk&&lnk.pump,e);}
  }
  await dbSet(db,"pl_cool",cool);
  await dbSet(db,"pl_hist",hist);
  await dbSet(db,"pl_cmd_pend",cmdPend);
  await dbSet(db,"pl_state_src",stateSrc);
}
/* ═══════════════ Lifecycle events ═══════════════ */
self.addEventListener("install",function(){self.skipWaiting();});
self.addEventListener("activate",function(eAct){
  eAct.waitUntil(self.clients.claim().then(function(){
    if(self._swHb)clearInterval(self._swHb);
    self._swHb=setInterval(function(){bgPoll().catch(function(e){console.warn("[SW] bgPoll error:",e);});},60000);
  }));
});
self.addEventListener("message",function(e){
  var d=e.data;if(!d)return;
  if(d.type==="AGUS_CFG"){
    dbOpen().then(function(db){
      return Promise.all([
        dbSet(db,"cfg",d.cfg),
        d.prev?dbSet(db,"prev",d.prev):Promise.resolve()
      ]);
    }).then(function(){bgPoll().catch(function(e){console.warn("[SW] bgPoll error:",e);});});
  }
  if(d.type==="AGUS_NOTIFY"){
    self.registration.showNotification(d.title,d.opts||{});
  }
  if(d.type==="AGUS_PL"){
    dbOpen().then(function(db2){
      return dbGet(db2,"cfg").then(function(existCfg){
        var merged=Object.assign({},existCfg||{});
        if(d.links)merged.pumpLinks=d.links;
        if(d.baseCfg){
          if(d.baseCfg.apiUrl)merged.apiUrl=d.baseCfg.apiUrl;
          if(d.baseCfg.token)merged.token=d.baseCfg.token;
        }
        /* ★ NEW: Accept gasTriggerInstalled flag from frontend */
        if(typeof d.gasTriggerInstalled==='boolean')merged.gasTriggerInstalled=d.gasTriggerInstalled;
        /* ★ NEW: Accept schedule cooldowns from frontend */
        if(d.schCool){
          return Promise.all([
            dbSet(db2,"cfg",merged),
            d.manCool?dbSet(db2,"pl_man_cool",d.manCool):Promise.resolve(),
            dbSet(db2,"pl_sch_cool",d.schCool)
          ]);
        }
        return Promise.all([
          dbSet(db2,"cfg",merged),
          d.manCool?dbSet(db2,"pl_man_cool",d.manCool):Promise.resolve()
        ]);
      });
    }).then(function(){bgPoll().catch(function(e){console.warn("[SW] bgPoll error:",e);});});
  }
  /* ★ NEW: Frontend sets/clears in-flight command lock for dashboard toggles */
  if(d.type==="AGUS_PL_CMD_LOCK"){
    dbOpen().then(function(db3){
      return dbGet(db3,"pl_cmd_pend").then(function(cp){
        cp=cp||{};
        if(d.lock){
          cp[d.device]=Date.now()+30000;
        }else{
          delete cp[d.device];
        }
        return dbSet(db3,"pl_cmd_pend",cp);
      });
    }).catch(function(e){console.warn("[SW] AGUS_PL_CMD_LOCK error:",e);});
  }
  if(d.type==="AGUS_KEEPALIVE"||d.type==="AGUS_PING"){
    if(e.source)try{e.source.postMessage({type:"AGUS_ALIVE"});}catch(x){}
  }
  if(d.type==="AGUS_SPEAK_RELAY"&&d.text){
    self.clients.matchAll({type:"window",includeUncontrolled:true}).then(function(cs){
      cs.forEach(function(c){try{c.postMessage({type:"AGUS_SPEAK",text:d.text});}catch(x){}});
    });
  }
  if(d.type==="AGUS_FOCUS"){
    self.clients.matchAll({type:"window",includeUncontrolled:true}).then(function(cs){
      cs.forEach(function(c){if(c.url)c.focus().catch(function(){});});
    });
  }
});
self.addEventListener("notificationclick",function(e){
  var nd=e.notification.data||{};
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(function(cs){
    var target=null;
    for(var i=0;i<cs.length;i++){if(cs[i].url&&cs[i].focus){cs[i].focus();target=cs[i];break;}}
    var p=target?Promise.resolve(target):(self.clients.openWindow?self.clients.openWindow("/"):Promise.resolve(null));
    return p.then(function(c){if(c&&nd.tts)setTimeout(function(){c.postMessage({type:"AGUS_SPEAK",text:nd.tts});},800);});
  }));
});
self.addEventListener("periodicsync",function(e){
  if(e.tag==="agus-bg")e.waitUntil(bgPoll());
});
self.addEventListener("push",function(e){
  e.waitUntil(bgPoll());
});
