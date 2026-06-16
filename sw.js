/* AGUS Service Worker — pump-link auto-control + push notifications
   Supports background operation even when dashboard tabs are closed.
   Config is received via postMessage and persisted in IndexedDB. */
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
var _dd={};var COOL=300000;
function can(k){var n=Date.now();if(_dd[k]&&n-_dd[k]<COOL)return false;_dd[k]=n;return true;}
var _swErr=0;
/* ═══════════════ Notification helper ═══════════════ */
function pop(title,body,tag,urgent){
  var ttsMsg = title + ". " + body;
  if (urgent) {
    self.clients.matchAll({type:"window",includeUncontrolled:true}).then(function(cs){
      cs.forEach(function(c){ c.postMessage({type:"AGUS_SPEAK",text:ttsMsg}); });
    });
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
  try{
    if(_swErr>5){_swErr=0;console.warn("[SW] Too many errors — pausing 10min");return;}
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
    devs.forEach(function(d){
      var n=d.device||"",st=d.status||"",p=prev[n]||{},t=Object.assign({},DEF,thr[n]||{});
      if((st==="Fault"||d.button)&&p.status!=="Fault"&&can("fault:"+n))
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
    await pumpLinkControl(cfg,devs,db,ps);
    await Promise.all(ps);
    _swErr=0;
  }catch(err){console.error("[SW] bgPoll:",err);_swErr++}
  if(_swErr>5){_swErr=0;console.warn("[SW] Too many errors — pausing 10min");return;}
}
/* ═══════════════ Pump toggle helper ═══════════════ */
async function swTogglePump(apiUrl,token,device){
  try{
    var r=await fetch(apiUrl,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action:"togglePump",token:token,device:device,latitude:"",longitude:""})});
    if(!r.ok)return null;return await r.json();
  }catch(e){console.warn("[SW] togglePump error:",e);return null;}
}
/* ═══════════════ Pump-link auto-control ═══════════════ */
async function pumpLinkControl(cfg,devs,db,ps){
  var links=cfg.pumpLinks||[];
  if(!links.length){
    try{
      var lr=await fetch(cfg.apiUrl,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"getPumpLinks",token:cfg.token})});
      if(lr.ok){var ld=await lr.json();if(Array.isArray(ld)){links=ld;}}
    }catch(e){console.warn("[SW] getPumpLinks error:",e);}
  }
  if(!links.length)return;
  var cool=(await dbGet(db,"pl_cool"))||{};
  var manCool=(await dbGet(db,"pl_man_cool"))||{};
  var now=Date.now();var PL_COOL=300000;
  var devMap={};devs.forEach(function(d){devMap[d.device]=d;});
  for(var i=0;i<links.length;i++){
    var lnk=links[i];
    if(!lnk.enabled)continue;
    if(lnk.manualOverride)continue;
    if(manCool[lnk.pump]&&now<manCool[lnk.pump])continue;
    var resD=devMap[lnk.reservoir],pumD=devMap[lnk.pump];
    if(!resD||!pumD)continue;
    var lv=parseFloat(resD.level);if(isNaN(lv))continue;
    var sOff=parseFloat(lnk.shutoffLevel),sRes=parseFloat(lnk.resumeLevel);
    var sOff2=parseFloat(lnk.shutoffLevel2)||0,sRes2=parseFloat(lnk.resumeLevel2)||0;
    if(isNaN(sOff)||isNaN(sRes))continue;
    var pOn=pumD.commandedRelay==1||pumD.commandedRelay===true||pumD.relay==1||pumD.relay===true||pumD.relay==="1";
    var ck=lnk.pump;  // pump-only key prevents race when two reservoirs share one pump
    if(cool[ck]&&now-cool[ck]<PL_COOL)continue;
    var needOff=pOn&&(lv>=sOff||(sOff2>0&&lv>=sOff2));
    var needOn=!pOn&&(lv<=sRes||(sRes2>0&&lv<=sRes2));
    if(!needOff&&!needOn)continue;
    var tr=await swTogglePump(cfg.apiUrl,cfg.token,lnk.pump);
    if(tr&&tr.success){
      cool[ck]=now;
      var newOn=!!tr.newState;
      var lvStr=lv.toFixed(1)+" m³";
      var thresh=newOn?"resumed ≤"+sRes+" m³":"shut off ≥"+sOff+" m³";
      ps.push(pop((newOn?"▶️ Auto-ON: ":"⏹️ Auto-OFF: ")+lnk.pump,
        lnk.reservoir+" "+thresh+". Level: "+lvStr,"pl:"+ck,true));
    }
  }
  await dbSet(db,"pl_cool",cool);
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
        return Promise.all([
          dbSet(db2,"cfg",merged),
          d.manCool?dbSet(db2,"pl_man_cool",d.manCool):Promise.resolve()
        ]);
      });
    }).then(function(){bgPoll().catch(function(e){console.warn("[SW] bgPoll error:",e);});});
  }
  if(d.type==="AGUS_KEEPALIVE"||d.type==="AGUS_PING"){
    if(e.source)try{e.source.postMessage({type:"AGUS_ALIVE"});}catch(x){}
  }
  if(d.type==="AGUS_SPEAK_RELAY"&&d.text){
    self.clients.matchAll({type:"window",includeUncontrolled:true}).then(function(cs){
      cs.forEach(function(c){try{c.postMessage({type:"AGUS_SPEAK",text:d.text});}catch(x){}});
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
