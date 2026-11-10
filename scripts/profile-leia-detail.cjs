// Detailed stereo pipeline profile: packet composition, mirror frame timing, paint cadence, presenter cadence.
// Usage: electron scripts/profile-leia-detail.cjs [--large] [--present]
const {app,BrowserWindow,ipcMain}=require('electron'),path=require('node:path');const {LeiaOutput}=require('../leia-output');
app.commandLine.appendSwitch('force-high-performance-gpu');process.env.LEIA_PROFILE='1';app.commandLine.appendSwitch('force-gpu-mem-available-mb',(process.argv.find(a=>a.startsWith('--mem='))||'=3072').split('=')[1]);
app.whenReady().then(async()=>{
 const large=process.argv.includes('--large');const size=large?[3840,2160]:[1440,900];
 const host=new BrowserWindow({show:true,width:size[0],height:size[1],webPreferences:{preload:path.join(__dirname,'bench-leia-preload.cjs'),contextIsolation:true,sandbox:false,backgroundThrottling:false}});
 host.isFocused=()=>true;let output;const packets=[];
 ipcMain.on('profile:snapshot',(_,data)=>{const t=process.hrtime.bigint();const bytes=JSON.stringify(data).length;const kinds={};for(const p of data.patches||[])kinds[p.type]=(kinds[p.type]||0)+1;packets.push({t:Number(t/1000000n),bytes,type:data.type,patches:(data.patches||[]).length,kinds,anims:(data.animations||[]).length,cancels:(data.cancelAnimations||[]).length,attrs:!!data.attributes,textures:(data.textures||[]).length,sample:(data.patches||[]).slice(0,3).map(p=>({type:p.type,id:p.id,len:JSON.stringify(p).length,keys:Object.keys(p.attributes||{})}))});output?.push({...data,active:process.argv.includes('--present')&&data.active});});
 const timeout=setTimeout(()=>{output?.disable();app.exit(1)},90000);
 try{
  if(large)host.setFullScreen(true);await host.loadFile(path.resolve('renderer/index.html'));await new Promise(r=>setTimeout(r,1200));host.focus();
  host.setAlwaysOnTop(true);app.focus({steal:true});host.focus();
  output=new LeiaOutput(host,()=>{});output.quality=(process.argv.find(a=>a.startsWith('--quality='))||'=native').split('=')[1];const enabled=output.enable();
  await host.webContents.executeJavaScript("Object.defineProperty(document,'hidden',{get:()=>false});LeiaUI.toggle();LeiaUI.snapshot()");await enabled;
  const paints=[];output.mirror.webContents.on('paint',()=>paints.push(performance.now()));
  await output.mirror.webContents.executeJavaScript("window.prof={frames:[],loaf:[]};(()=>{let last=performance.now();const tick=n=>{prof.frames.push(n-last);last=n;requestAnimationFrame(tick)};requestAnimationFrame(tick);try{new PerformanceObserver(l=>{for(const e of l.getEntries())prof.loaf.push({d:e.duration,block:e.blockingDuration,render:e.renderStart?e.startTime+e.duration-e.renderStart:0,style:e.styleAndLayoutStart?e.startTime+e.duration-e.styleAndLayoutStart:0})}).observe({type:'long-animation-frame',buffered:false})}catch(e){prof.err=String(e)}})();0");
  await host.webContents.executeJavaScript("window.hostFrames=[];(()=>{let last=performance.now();const tick=n=>{hostFrames.push(n-last);last=n;requestAnimationFrame(tick)};requestAnimationFrame(tick)})();0");
  const cadences=[];const poll=setInterval(()=>{if(output.cadence)cadences.push(output.cadence);output.cadence=null;},1000);
  const startPackets=packets.length,startCompleted=output.completed,begin=Date.now();
  if(process.argv.includes('--mouse')){
   // Real input events in a circle at ~125 Hz, like a moving mouse.
   const [w,h]=host.getContentSize();const t0=Date.now();
   await new Promise(done=>{const timer=setInterval(()=>{const t=(Date.now()-t0)/1000;if(t>6){clearInterval(timer);return done();}host.webContents.sendInputEvent({type:'mouseMove',x:Math.round(w/2+Math.cos(t*3)*w*.3),y:Math.round(h/2+Math.sin(t*3)*h*.3)});},8);});
  }else{
   await host.webContents.executeJavaScript("window.profileNavigation=setInterval(()=>{navigateGame(1)},700)");
   await new Promise(r=>setTimeout(r,6000));
   await host.webContents.executeJavaScript('clearInterval(window.profileNavigation)');
  }
  await new Promise(r=>setTimeout(r,1500));
  const idleStart=packets.length;await new Promise(r=>setTimeout(r,2000));const idlePackets=packets.length-idleStart;
  clearInterval(poll);
  const mirror=await output.mirror.webContents.executeJavaScript("(()=>{const f=prof.frames.slice(5).sort((a,b)=>a-b);const q=p=>f[Math.floor(f.length*p)]||0;return {count:prof.frames.length,p50:q(.5),p90:q(.9),p99:q(.99),max:f[f.length-1],loafCount:prof.loaf.length,loafMax:Math.max(0,...prof.loaf.map(e=>e.d)),loafStyleMean:prof.loaf.reduce((a,e)=>a+e.style,0)/(prof.loaf.length||1),err:prof.err}})()");
  const hostF=await host.webContents.executeJavaScript("(()=>{const f=hostFrames.slice(5).sort((a,b)=>a-b);const q=p=>f[Math.floor(f.length*p)]||0;return {count:hostFrames.length,p50:q(.5),p90:q(.9),max:f[f.length-1]}})()");
  const gaps=paints.slice(1).map((t,i)=>t-paints[i]).sort((a,b)=>a-b);const gq=p=>gaps[Math.floor(gaps.length*p)]||0;
  const nav=packets.slice(startPackets);const bytes=nav.reduce((a,p)=>a+p.bytes,0);const kinds={};for(const p of nav)for(const [k,v] of Object.entries(p.kinds))kinds[k]=(kinds[k]||0)+v;
  const biggest=[...nav].sort((a,b)=>b.bytes-a.bytes).slice(0,4);
  console.log(JSON.stringify({size,elapsedMs:Date.now()-begin,packets:nav.length,idlePacketsPer2s:idlePackets,meanBytes:Math.round(bytes/(nav.length||1)),kinds,anims:nav.reduce((a,p)=>a+p.anims,0),biggest,completedTextures:output.completed-startCompleted,paintCount:paints.length,paintGap:{p50:gq(.5),p90:gq(.9),p99:gq(.99),max:gaps[gaps.length-1]},mirror,host:hostF,cadences,diag:output.diagnostics()},null,1));
  output.disable();host.destroy();clearTimeout(timeout);setTimeout(()=>app.exit(0),500);
 }catch(e){console.error(e);output?.disable();clearTimeout(timeout);app.exit(1)}
});
