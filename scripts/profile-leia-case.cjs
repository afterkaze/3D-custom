// Stereo case viewer while dragging the case around: new stereo frames/s, longest gap, eye frame times.
// Usage: electron scripts/profile-leia-case.cjs [--large] [--quality=native] [--seconds=4]
const {app,BrowserWindow,ipcMain}=require('electron'),path=require('node:path');const {LeiaOutput}=require('../leia-output');
app.commandLine.appendSwitch('force-high-performance-gpu');app.commandLine.appendSwitch('force-gpu-mem-available-mb','3072');process.env.LEIA_PROFILE='1';
const arg=(name,fallback)=>(process.argv.find(a=>a.startsWith('--'+name+'='))||'='+fallback).split('=')[1];
app.whenReady().then(async()=>{
 const large=process.argv.includes('--large'),seconds=Number(arg('seconds',4));
 const host=new BrowserWindow({show:true,width:large?3840:1440,height:large?2160:900,webPreferences:{preload:path.join(__dirname,'bench-leia-preload.cjs'),contextIsolation:true,sandbox:false,backgroundThrottling:false}});
 host.isFocused=()=>true;let output,packets=0,bytes=0;
 ipcMain.on('profile:snapshot',(_,data)=>{packets++;bytes+=JSON.stringify(data.patches||[]).length;output?.push({...data,active:data.active});});
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 try{
  if(large)host.setFullScreen(true);await host.loadFile(path.resolve('renderer/index.html'));await pause(1200);
  output=new LeiaOutput(host,()=>{});output.quality=arg('quality','native');const enabled=output.enable();
  await host.webContents.executeJavaScript("Object.defineProperty(document,'hidden',{get:()=>false});document.hasFocus=()=>true;LeiaUI.toggle();LeiaUI.snapshot()");await enabled;await pause(1200);
  host.focus();
  await host.webContents.executeJavaScript('openCase();0');await pause(2600); // opening tween + case opening
  const [w,h]=host.getContentSize();
  // --eyecss="…" injects CSS into both eyes, to measure what a style costs while the case moves.
  const eyeCss=arg('eyecss','');if(eyeCss)await output.mirror.webContents.executeJavaScript(`for(const id of ['left','right']){const d=document.querySelector('#'+id).contentDocument,s=d.createElement('style');s.textContent=${JSON.stringify(eyeCss)};d.head.append(s)}0`);
  const hostCss=arg('hostcss','');if(hostCss)await host.webContents.executeJavaScript(`{const s=document.createElement('style');s.textContent=${JSON.stringify(hostCss)};document.head.append(s)}0`);
  const caseSize=arg('casesize','');if(caseSize)await host.webContents.executeJavaScript(`Appearance.apply({caseSize:'${caseSize}',infoBar:'hidden'},false);0`);
  // Mirror-side frame timing in each eye.
  await output.mirror.webContents.executeJavaScript(`window.__ft=[];for(const id of ['left','right']){const win=document.querySelector('#'+id).contentWindow;let last=0;const tick=t=>{if(last)window.__ft.push(t-last);last=t;win.requestAnimationFrame(tick)};win.requestAnimationFrame(tick)}0`);
  const cadences=[];const timer=setInterval(()=>{if(output.cadence)cadences.push(output.cadence)},1000);
  const traceFile=arg('trace','');if(traceFile)await require('electron').contentTracing.startRecording({included_categories:['devtools.timeline','blink','cc','gpu','viz','benchmark','v8.execute','disabled-by-default-devtools.timeline','gpu.capture','disabled-by-default-gpu.capture','media']});
  let paints=0;output.mirror.webContents.on('paint',()=>paints++);const completedBefore=output.completed;
  // How long the presenter holds each frame (capture stalls while frames are held).
  const held=[],since=new Map(),map=output.pending,set=map.set.bind(map),del=map.delete.bind(map);
  map.set=(k,v)=>{since.set(k,performance.now());return set(k,v)};map.delete=k=>{if(since.has(k)){held.push(performance.now()-since.get(k));since.delete(k)}return del(k)};
  packets=0;bytes=0;const t0=Date.now();
  host.webContents.sendInputEvent({type:'mouseDown',x:Math.round(w/2),y:Math.round(h/2),button:'left',clickCount:1});
  await new Promise(done=>{const timer=setInterval(()=>{const t=(Date.now()-t0)/1000;if(t>seconds){clearInterval(timer);return done();}host.webContents.sendInputEvent({type:'mouseMove',x:Math.round(w/2+Math.sin(t*2.2)*w*.25),y:Math.round(h/2+Math.sin(t*1.3)*h*.12),button:'left',modifiers:['leftButtonDown']});},8);});
  host.webContents.sendInputEvent({type:'mouseUp',x:Math.round(w/2),y:Math.round(h/2),button:'left',clickCount:1});
  clearInterval(timer);
  if(traceFile){await require('electron').contentTracing.stopRecording(path.resolve(traceFile));console.log('pids',JSON.stringify({host:host.webContents.getOSProcessId(),mirror:output.mirror.webContents.getOSProcessId()}));}
  const ft=await output.mirror.webContents.executeJavaScript('window.__ft.slice(20)');ft.sort((a,b)=>a-b);const p=q=>ft.length?+ft[Math.floor(ft.length*q)].toFixed(1):0;
  const hostFt=await host.webContents.executeJavaScript('0');
  const moved=await host.webContents.executeJavaScript('CV.ry.toFixed(1)');
  held.sort((a,b)=>a-b);const hp=q=>held.length?+held[Math.floor(held.length*q)].toFixed(1):0;
  console.log(JSON.stringify({heldMs:{p50:hp(.5),p90:hp(.9),max:hp(.999)},paintsPerSecond:+(paints/seconds).toFixed(1),copiedPerSecond:+((output.completed-completedBefore)/seconds).toFixed(1),size:output.textureSize,quality:output.quality,packetsPerSecond:+(packets/seconds).toFixed(1),patchBytesPerSecond:Math.round(bytes/seconds),eyeFrameMs:{p50:p(.5),p90:p(.9),p99:p(.99),max:ft.at(-1)},cadence:cadences.map(c=>[Math.round(c.fps),Math.round(c.presentFps),c.longestGapMs]),caseRy:moved}));
 }catch(e){console.error(e)}
 output?.disable();host.destroy();setTimeout(()=>app.exit(0),500);
});
